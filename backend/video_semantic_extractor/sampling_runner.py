"""@type implementation
@purpose Execute one leased sampling job and register its verified frame set.
@dependencies api.py, pipeline.py
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

import cv2
import requests
from fastapi import FastAPI, HTTPException

from .api import _setting_int, download_video
from .pipeline import (
    ExtractionError,
    FrameCandidate,
    _extract_frame_candidates,
    probe_video,
    select_frame_candidates,
)


class RunnerError(RuntimeError):
    """Raised when control-plane or sampling execution fails."""


logger = logging.getLogger("video_semantic_extractor.sampling_runner")
logger.setLevel(logging.INFO)


def _log_event(event: str, **fields: Any) -> None:
    logger.info(json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":")))


class Executor(Protocol):
    def run_once(self) -> dict[str, Any]: ...


class ControlPlaneClient:
    """Call the runner API through the Container's virtual service-binding host."""

    def __init__(self, base_url: str | None = None, timeout: int = 120) -> None:
        self.base_url = (base_url or os.getenv("CONTROL_PLANE_URL", "http://control.internal")).rstrip("/")
        self.timeout = timeout

    def request(self, method: str, path: str, *, lease: str | None = None, json_body: object | None = None, data: bytes | None = None, media_type: str | None = None) -> dict[str, Any]:
        headers = {"accept": "application/json"}
        if lease:
            headers["x-job-lease-token"] = lease
        if media_type:
            headers["content-type"] = media_type
            headers["content-length"] = str(len(data or b""))
        started_at = time.monotonic()
        operation = next(
            (name for name in ("claim", "heartbeat", "sources", "artifacts", "finalize", "fail") if path.endswith(f"/{name}")),
            "artifact_upload" if method == "PUT" else "unknown",
        )
        try:
            response = requests.request(method, f"{self.base_url}{path}", headers=headers, json=json_body, data=data, timeout=self.timeout)
        except requests.RequestException as exc:
            _log_event(
                "control_plane_request_failed",
                method=method,
                operation=operation,
                duration_ms=round((time.monotonic() - started_at) * 1000),
                error_type=type(exc).__name__,
            )
            raise
        try:
            payload = response.json()
        except requests.JSONDecodeError as exc:
            _log_event(
                "control_plane_invalid_response",
                method=method,
                operation=operation,
                status=response.status_code,
                duration_ms=round((time.monotonic() - started_at) * 1000),
            )
            raise RunnerError(f"control plane returned non-JSON status {response.status_code}") from exc
        _log_event(
            "control_plane_response",
            method=method,
            operation=operation,
            status=response.status_code,
            duration_ms=round((time.monotonic() - started_at) * 1000),
        )
        if not response.ok:
            detail = payload.get("error", {})
            message = detail.get("message", detail) if isinstance(detail, dict) else detail
            raise RunnerError(f"control plane rejected {path}: {message}")
        return payload


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _candidates(input_path: Path, output_dir: Path, config: dict[str, Any], duration: float) -> list[FrameCandidate]:
    method = config["method"]
    candidates: list[FrameCandidate] = []
    if method in {"scene", "hybrid"}:
        candidates.extend(_extract_frame_candidates(input_path, output_dir / "scene", f"eq(n,0)+gt(scene,{config['scene_threshold']})", "scene_change"))
    if method in {"interval", "hybrid"}:
        candidates.extend(_extract_frame_candidates(input_path, output_dir / "interval", f"eq(n,0)+gte(t-prev_selected_t,{config['interval_seconds']})", "interval"))
    if config.get("include_final_frame", True):
        interval = float(config.get("interval_seconds", 5.0))
        tail = _extract_frame_candidates(input_path, output_dir / "near-final", f"gte(t,{max(0.0, duration - min(0.5, interval / 2))})", "near_final")
        if tail:
            candidate = tail[-1]
            reasons = candidate.sampling_reasons
            if reasons == ("first",):
                reasons = ("first", "near_final")
            candidates.append(FrameCandidate(candidate.path, candidate.timestamp_sec, reasons))
    return select_frame_candidates(candidates, int(config.get("max_frames", 250)))


class SamplingRunner:
    """Claim and execute one job; repeated invocations safely return when idle."""

    def __init__(self, control: ControlPlaneClient | None = None) -> None:
        self.control = control or ControlPlaneClient(timeout=_setting_int("RUNNER_REQUEST_TIMEOUT_SEC", 120))
        self.runner_id = os.getenv("RUNNER_ID", "cloudflare-sampling-runner")
        self.lease_seconds = _setting_int("RUNNER_LEASE_SECONDS", 300)

    def _heartbeat(self, job_id: str, lease: str, stop: threading.Event, abort: threading.Event, cancelled: threading.Event) -> None:
        while not stop.wait(max(10, self.lease_seconds // 3)):
            try:
                result = self.control.request("POST", f"/api/internal/v1/runner/sampling-jobs/{job_id}/heartbeat", lease=lease, json_body={"lease_seconds": self.lease_seconds})
                if result["data"].get("cancellation_requested"):
                    _log_event("sampling_job_cancellation_requested", job_id=job_id)
                    cancelled.set()
                    abort.set()
                    return
            except (requests.RequestException, RunnerError) as exc:
                _log_event("sampling_job_heartbeat_failed", job_id=job_id, error_type=type(exc).__name__)
                abort.set()
                return

    def run_once(self) -> dict[str, Any]:
        claim = self.control.request("POST", "/api/internal/v1/runner/sampling-jobs/claim", json_body={"runner_id": self.runner_id, "lease_seconds": self.lease_seconds}).get("data")
        if claim is None:
            _log_event("sampling_runner_idle", runner_id=self.runner_id)
            return {"status": "idle"}
        job, lease = claim["job"], claim["lease_token"]
        job_id, config = job["id"], job["input"]
        _log_event(
            "sampling_job_claimed",
            runner_id=self.runner_id,
            job_id=job_id,
            attempt_count=job.get("attempt_count"),
            frame_set_id=claim.get("frame_set_id"),
        )
        stop, abort, cancelled = threading.Event(), threading.Event(), threading.Event()
        heartbeat = threading.Thread(target=self._heartbeat, args=(job_id, lease, stop, abort, cancelled), daemon=True)
        heartbeat.start()
        try:
            source_payload = self.control.request("GET", f"/api/internal/v1/runner/dataset-versions/{config['dataset_version_id']}/sources")["data"]
            manifest_sources: list[dict[str, Any]] = []
            with tempfile.TemporaryDirectory(prefix=f"sampling-{job_id}-") as directory:
                root = Path(directory)
                for source in source_payload["sources"]:
                    if abort.is_set():
                        raise RunnerError("sampling cancelled or heartbeat lease lost")
                    download_started_at = time.monotonic()
                    source_dir = root / str(source["ordinal"])
                    source_dir.mkdir()
                    video = source_dir / "source.video"
                    download_video(source["url"], video, _setting_int("RUNNER_MAX_DOWNLOAD_BYTES", 500_000_000), _setting_int("RUNNER_DOWNLOAD_TIMEOUT_SEC", 120))
                    _log_event(
                        "sampling_source_downloaded",
                        job_id=job_id,
                        source_id=source["id"],
                        size_bytes=video.stat().st_size,
                        duration_ms=round((time.monotonic() - download_started_at) * 1000),
                    )
                    metadata = probe_video(video)
                    frames = []
                    for ordinal, candidate in enumerate(_candidates(video, source_dir / "frames", config, metadata.duration_sec)):
                        if abort.is_set():
                            raise RunnerError("sampling cancelled or heartbeat lease lost")
                        image = cv2.imread(str(candidate.path))
                        if image is None:
                            raise RunnerError(f"could not decode sampled frame {candidate.path.name}")
                        frame_bytes = candidate.path.read_bytes()
                        checksum = hashlib.sha256(frame_bytes).hexdigest()
                        reservation = self.control.request("POST", f"/api/internal/v1/runner/sampling-jobs/{job_id}/artifacts", lease=lease, json_body={"sha256": checksum, "size_bytes": len(frame_bytes), "media_type": "image/jpeg"})["data"]
                        self.control.request("PUT", reservation["upload_path"], lease=lease, data=frame_bytes, media_type="image/jpeg")
                        frames.append({"id": f"frame_{source['ordinal']}_{ordinal}", "timestamp_seconds": candidate.timestamp_sec, "reasons": list(candidate.sampling_reasons), "width": int(image.shape[1]), "height": int(image.shape[0]), "artifact": {"artifact_id": reservation["id"], "sha256": checksum, "size_bytes": len(frame_bytes), "media_type": "image/jpeg"}})
                    manifest_sources.append({"dataset_source_id": source["id"], "source_sha256": _sha256(video), "size_bytes": video.stat().st_size, "duration_seconds": metadata.duration_sec, "frames": frames})
                    _log_event(
                        "sampling_source_processed",
                        job_id=job_id,
                        source_id=source["id"],
                        frame_count=len(frames),
                    )
            configuration_sha = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            manifest = {"schema_version": "frame-set-manifest.v1", "frame_set_id": claim["frame_set_id"], "sampling_job_id": job_id, "dataset_version_id": config["dataset_version_id"], "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "engine": {"name": "video-semantic-extractor", "version": "1.0.0", "configuration_sha256": configuration_sha}, "source_count": len(manifest_sources), "frame_count": sum(len(source["frames"]) for source in manifest_sources), "sources": manifest_sources}
            result = self.control.request("POST", f"/api/internal/v1/runner/sampling-jobs/{job_id}/finalize", lease=lease, json_body={"manifest": manifest})
            _log_event(
                "sampling_job_succeeded",
                job_id=job_id,
                frame_set_id=claim["frame_set_id"],
                source_count=len(manifest_sources),
                frame_count=manifest["frame_count"],
            )
            return {"status": "succeeded", "job_id": job_id, "frame_set": result["data"]}
        except Exception as exc:
            _log_event("sampling_job_failed", job_id=job_id, error_type=type(exc).__name__)
            try:
                self.control.request("POST", f"/api/internal/v1/runner/sampling-jobs/{job_id}/fail", lease=lease, json_body={"error_message": str(exc)[:2000], "requeue": not cancelled.is_set()})
            except Exception as report_error:
                _log_event(
                    "sampling_job_failure_report_failed",
                    job_id=job_id,
                    error_type=type(report_error).__name__,
                )
            raise
        finally:
            stop.set()
            heartbeat.join(timeout=2)


def create_runner_app(executor: Executor | None = None) -> FastAPI:
    app = FastAPI(title="Video Semantic Sampling Runner", version="1.0.0")
    runner = executor or SamplingRunner()
    execution_lock = threading.Lock()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/run-once")
    def run_once() -> dict[str, Any]:
        if not execution_lock.acquire(blocking=False):
            _log_event("sampling_runner_busy")
            return {"status": "busy"}
        started_at = time.monotonic()
        _log_event("sampling_runner_execution_started")
        try:
            result = runner.run_once()
            _log_event(
                "sampling_runner_execution_completed",
                status=result.get("status", "unknown"),
                duration_ms=round((time.monotonic() - started_at) * 1000),
            )
            return result
        except (ExtractionError, RunnerError, requests.RequestException, ValueError) as exc:
            _log_event(
                "sampling_runner_execution_failed",
                duration_ms=round((time.monotonic() - started_at) * 1000),
                error_type=type(exc).__name__,
            )
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        finally:
            execution_lock.release()

    return app


app = create_runner_app()
