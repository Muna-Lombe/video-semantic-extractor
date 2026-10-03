#!/usr/bin/env python3
"""@type script @purpose Verify a deployed sampling runner with real remote media."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}


class SmokeTestError(RuntimeError):
    """Raised when the deployed control plane fails a smoke-test assertion."""


class ControlPlaneClient:
    """Minimal administrator client that never includes its bearer token in errors."""

    def __init__(self, base_url: str, token: str, timeout_seconds: float = 30) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
            raise SmokeTestError("control-plane URL must be an HTTPS origin without query or fragment")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_seconds = timeout_seconds

    def request(self, method: str, path: str, payload: object | None = None) -> tuple[Any, dict[str, str]]:
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        headers = {"accept": "application/json", "authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["content-type"] = "application/json"
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                detail = json.loads(body).get("error", {})
                message = detail.get("message", detail) if isinstance(detail, dict) else detail
            except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                message = body.decode("utf-8", errors="replace")[:500]
            raise SmokeTestError(f"{method} {path} returned HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            raise SmokeTestError(f"could not reach control plane for {method} {path}: {exc.reason}") from exc
        content_type = response_headers.get("content-type", "").split(";", 1)[0]
        if content_type == "application/json":
            try:
                return json.loads(body), response_headers
            except json.JSONDecodeError as exc:
                raise SmokeTestError(f"{method} {path} returned invalid JSON") from exc
        return body, response_headers


def _require_mapping(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SmokeTestError(f"{context} must be a JSON object")
    return value


def _data(payload: Any, context: str) -> dict[str, Any]:
    root = _require_mapping(payload, context)
    return _require_mapping(root.get("data"), f"{context}.data")


def run_smoke_test(
    client: ControlPlaneClient,
    source_url: str,
    *,
    poll_interval_seconds: float,
    timeout_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
    progress: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Create a dataset and job, then verify the finalized manifest and first frame."""

    parsed_source = urllib.parse.urlparse(source_url)
    if parsed_source.scheme != "https" or not parsed_source.netloc:
        raise SmokeTestError("media source must be an HTTPS URL")

    unique = int(time.time())
    dataset_payload, _ = client.request(
        "POST",
        "/api/internal/v1/datasets",
        {
            "name": f"sampling-runner-smoke-{unique}",
            "description": "Automated deployed-runner real-media smoke test",
            "sources": [{"url": source_url, "display_name": Path(parsed_source.path).name or "sample-media"}],
        },
    )
    dataset = _data(dataset_payload, "dataset response")
    initial_version = _require_mapping(dataset.get("initial_version"), "dataset initial_version")
    version_id = initial_version.get("id")
    if not isinstance(version_id, str) or not version_id:
        raise SmokeTestError("dataset response did not include an initial version ID")
    progress(f"dataset={dataset.get('id')} version={version_id}")

    job_payload, _ = client.request(
        "POST",
        "/api/internal/v1/sampling-jobs",
        {
            "dataset_version_id": version_id,
            "method": "hybrid",
            "scene_threshold": 0.3,
            "interval_seconds": 5,
            "max_frames": 20,
            "include_final_frame": True,
            "idempotency_key": f"sampling-runner-smoke-{unique}",
            "max_attempts": 2,
        },
    )
    job = _data(job_payload, "sampling-job response")
    job_id = job.get("id")
    if not isinstance(job_id, str) or not job_id:
        raise SmokeTestError("sampling-job response did not include a job ID")
    progress(f"job={job_id} status={job.get('status')}")

    deadline = time.monotonic() + timeout_seconds
    previous_status: object = None
    while job.get("status") not in TERMINAL_STATUSES:
        if time.monotonic() >= deadline:
            raise SmokeTestError(f"job {job_id} did not finish within {timeout_seconds:g} seconds")
        sleep(poll_interval_seconds)
        job_payload, _ = client.request("GET", f"/api/internal/v1/sampling-jobs/{urllib.parse.quote(job_id)}")
        job = _data(job_payload, "sampling-job status response")
        if job.get("status") != previous_status:
            progress(
                f"job={job_id} status={job.get('status')} attempts={job.get('attempt_count')} "
                f"heartbeat={job.get('heartbeat_at')}"
            )
            previous_status = job.get("status")

    if job.get("status") != "succeeded":
        raise SmokeTestError(
            f"job {job_id} ended as {job.get('status')}: {job.get('error_message') or 'no error detail'}"
        )
    output = _require_mapping(job.get("output"), "successful job output")
    frame_set_id = output.get("frame_set_id")
    if not isinstance(frame_set_id, str) or not frame_set_id:
        raise SmokeTestError("successful job did not identify its frame set")

    frame_set_payload, _ = client.request(
        "GET", f"/api/internal/v1/frame-sets/{urllib.parse.quote(frame_set_id)}"
    )
    frame_set = _data(frame_set_payload, "frame-set response")
    sources = frame_set.get("sources")
    frames = frame_set.get("frames")
    if frame_set.get("status") != "ready" or not isinstance(sources, list) or len(sources) != 1:
        raise SmokeTestError("frame set is not ready with exactly one registered source")
    if not isinstance(frames, list) or not frames:
        raise SmokeTestError("frame set contains no sampled frames")

    manifest_bytes, manifest_headers = client.request(
        "GET", f"/api/internal/v1/frame-sets/{urllib.parse.quote(frame_set_id)}/manifest"
    )
    if not isinstance(manifest_bytes, bytes):
        manifest_bytes = json.dumps(manifest_bytes, separators=(",", ":")).encode()
    manifest = _require_mapping(json.loads(manifest_bytes), "frame-set manifest")
    if manifest.get("frame_set_id") != frame_set_id or manifest.get("sampling_job_id") != job_id:
        raise SmokeTestError("manifest identity does not match the completed job and frame set")
    if manifest.get("source_count") != 1 or manifest.get("frame_count") != len(frames):
        raise SmokeTestError("manifest counts do not match registered frame-set membership")

    first_frame = _require_mapping(frames[0], "first frame")
    frame_id = first_frame.get("id")
    artifact = _require_mapping(first_frame.get("artifact"), "first frame artifact")
    if not isinstance(frame_id, str):
        raise SmokeTestError("first registered frame has no ID")
    evidence, evidence_headers = client.request(
        "GET",
        f"/api/internal/v1/frame-sets/{urllib.parse.quote(frame_set_id)}/frames/{urllib.parse.quote(frame_id)}/evidence",
    )
    if not isinstance(evidence, bytes):
        raise SmokeTestError("frame evidence endpoint did not return binary media")
    evidence_sha = hashlib.sha256(evidence).hexdigest()
    if evidence_sha != artifact.get("sha256") or len(evidence) != artifact.get("size_bytes"):
        raise SmokeTestError("retrieved frame bytes do not match registered size and SHA-256")

    report = {
        "status": "passed",
        "source_url": source_url,
        "dataset_id": dataset.get("id"),
        "dataset_version_id": version_id,
        "job_id": job_id,
        "attempt_count": job.get("attempt_count"),
        "heartbeat_at": job.get("heartbeat_at"),
        "frame_set_id": frame_set_id,
        "source_count": len(sources),
        "frame_count": len(frames),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "manifest_etag": manifest_headers.get("etag"),
        "evidence_frame_id": frame_id,
        "evidence_sha256": evidence_sha,
        "evidence_content_type": evidence_headers.get("content-type"),
    }
    progress(f"frame_set={frame_set_id} frames={len(frames)} evidence_sha256={evidence_sha}")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("control_plane_url", help="deployed control-plane HTTPS origin")
    parser.add_argument("source_url", help="public HTTPS video URL sampled by the deployed runner")
    parser.add_argument("--token-env", default="ADMIN_TOKEN", help="environment variable containing the administrator token")
    parser.add_argument("--poll-seconds", type=float, default=5, help="seconds between job status checks")
    parser.add_argument("--timeout-seconds", type=float, default=900, help="maximum wait for terminal job state")
    parser.add_argument("--output", type=Path, help="optional path for the non-secret JSON verification report")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.getenv(args.token_env)
    if not token:
        print(f"error: {args.token_env} is not set", file=sys.stderr)
        return 2
    try:
        report = run_smoke_test(
            ControlPlaneClient(args.control_plane_url, token),
            args.source_url,
            poll_interval_seconds=args.poll_seconds,
            timeout_seconds=args.timeout_seconds,
        )
    except (SmokeTestError, json.JSONDecodeError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{rendered}\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
