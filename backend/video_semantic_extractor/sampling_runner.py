"""@type implementation
@purpose Execute one leased sampling job and register its verified frame set.
@dependencies api.py, pipeline.py
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, Callable

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


# Keep finalized frames within the current hosted template generator's hard limit.
MAX_FRAME_SET_FRAMES = 500


def _source_frame_limit(per_source_limit: int, remaining_frames: int, remaining_sources: int) -> int:
    """Allocate a bounded, near-even frame budget while retaining one per source."""
    if per_source_limit < 1:
        raise RunnerError("per-source frame limit must be positive")
    if remaining_sources < 1 or remaining_frames < remaining_sources:
        raise RunnerError("frame-set limit cannot provide at least one frame per source")
    return min(per_source_limit, (remaining_frames + remaining_sources - 1) // remaining_sources)


def _log_event(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":")), flush=True)


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

    def download(self, path: str, *, lease: str, maximum_bytes: int = 16 * 1024 * 1024) -> bytes:
        """Fetch one lease-authorized immutable evaluation input as bytes."""
        try:
            response = requests.get(f"{self.base_url}{path}", headers={"x-job-lease-token": lease}, timeout=self.timeout, stream=True)
        except requests.RequestException as exc:
            _log_event("evaluation_input_download_failed", error_type=type(exc).__name__)
            raise
        try:
            if not response.ok:
                raise RunnerError(f"control plane rejected evaluation input download (HTTP {response.status_code})")
            payload = bytearray()
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if len(payload) + len(chunk) > maximum_bytes:
                    raise RunnerError("evaluation input exceeds the bounded download size")
                payload.extend(chunk)
            return bytes(payload)
        finally:
            response.close()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _candidates(input_path: Path, output_dir: Path, config: dict[str, Any], duration: float, should_abort: Callable[[], bool] | None = None) -> list[FrameCandidate]:
    method = config["method"]
    bounds = {"max_candidates": _setting_int("RUNNER_MAX_CANDIDATE_FRAMES", 2000), "max_output_bytes": _setting_int("RUNNER_MAX_CANDIDATE_BYTES", 512 * 1024 * 1024), "should_abort": should_abort}
    candidates: list[FrameCandidate] = []
    if method in {"scene", "hybrid"}:
        candidates.extend(_extract_frame_candidates(input_path, output_dir / "scene", f"eq(n,0)+gt(scene,{config['scene_threshold']})", "scene_change", **bounds))
    if method in {"interval", "hybrid"}:
        candidates.extend(_extract_frame_candidates(input_path, output_dir / "interval", f"eq(n,0)+gte(t-prev_selected_t,{config['interval_seconds']})", "interval", **bounds))
    if config.get("include_final_frame", True):
        interval = float(config.get("interval_seconds", 5.0))
        tail = _extract_frame_candidates(input_path, output_dir / "near-final", f"gte(t,{max(0.0, duration - min(0.5, interval / 2))})", "near_final", **bounds)
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
        self._prefer_evaluation = False
        self._progress: dict[str, Any] = {}

    def _heartbeat(self, job_id: str, lease: str, stop: threading.Event, abort: threading.Event, cancelled: threading.Event, job_type: str = "sampling") -> None:
        while not stop.wait(max(10, self.lease_seconds // 3)):
            try:
                result = self.control.request("POST", f"/api/internal/v1/runner/{job_type}-jobs/{job_id}/heartbeat", lease=lease, json_body={"lease_seconds": self.lease_seconds, "progress": dict(self._progress)})
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
        # Both queues make progress even while sampling work is continuously queued.
        if self._prefer_evaluation:
            self._prefer_evaluation = False
            result = self._run_evaluation_once()
            if result["status"] != "idle":
                return result
        claim = self.control.request("POST", "/api/internal/v1/runner/sampling-jobs/claim", json_body={"runner_id": self.runner_id, "lease_seconds": self.lease_seconds}).get("data")
        if claim is None:
            return self._run_evaluation_once()
        self._prefer_evaluation = True
        job, lease = claim["job"], claim["lease_token"]
        job_id, config = job["id"], job["input"]
        self._progress = {"stage": "resolving_sources", "completed_sources": 0}
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
            sources = source_payload["sources"]
            if not sources or len(sources) > MAX_FRAME_SET_FRAMES:
                raise RunnerError(f"sampling requires 1-{MAX_FRAME_SET_FRAMES} sources")
            remaining_frames = MAX_FRAME_SET_FRAMES
            with tempfile.TemporaryDirectory(prefix=f"sampling-{job_id}-") as directory:
                root = Path(directory)
                for source_index, source in enumerate(sources):
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
                    self._progress = {"stage": "sampling", "source_index": source_index, "source_count": len(sources)}
                    metadata = probe_video(video)
                    if metadata.duration_sec > _setting_int("RUNNER_MAX_DURATION_SECONDS", 900) or metadata.width * metadata.height > _setting_int("RUNNER_MAX_FRAME_PIXELS", 3840 * 2160):
                        raise RunnerError("source exceeds the runner duration or pixel budget")
                    frames = []
                    source_limit = _source_frame_limit(
                        int(config.get("max_frames", 250)),
                        remaining_frames,
                        len(sources) - source_index,
                    )
                    source_config = {**config, "max_frames": source_limit}
                    candidates = _candidates(video, source_dir / "frames", source_config, metadata.duration_sec, abort.is_set)
                    if not candidates:
                        raise RunnerError(f"sampling produced no frames for source {source['id']}")
                    for ordinal, candidate in enumerate(candidates):
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
                    remaining_frames -= len(frames)
                    self._progress = {"stage": "uploading", "completed_sources": source_index + 1, "source_count": len(sources), "uploaded_frames": MAX_FRAME_SET_FRAMES - remaining_frames}
                    # Frames have already been checksum-uploaded; retain metadata only.
                    # Deleting each source before downloading the next bounds temporary
                    # storage to one source and its extracted candidates at a time.
                    shutil.rmtree(source_dir)
                    _log_event(
                        "sampling_source_processed",
                        job_id=job_id,
                        source_id=source["id"],
                        frame_count=len(frames),
                    )
            configuration_sha = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            package = Path(__file__).resolve().parent
            implementation_sha = hashlib.sha256(b"pipeline.py\0" + (package / "pipeline.py").read_bytes() + b"sampling_runner.py\0" + (package / "sampling_runner.py").read_bytes()).hexdigest()
            manifest = {"schema_version": "frame-set-manifest.v1", "frame_set_id": claim["frame_set_id"], "sampling_job_id": job_id, "dataset_version_id": config["dataset_version_id"], "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "engine": {"name": "video-semantic-extractor", "version": f"1.0.0@sha256:{implementation_sha}", "configuration_sha256": configuration_sha}, "source_count": len(manifest_sources), "frame_count": sum(len(source["frames"]) for source in manifest_sources), "sources": manifest_sources}
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

    def _run_evaluation_once(self) -> dict[str, Any]:
        started_at = time.monotonic()
        claim = self.control.request("POST", "/api/internal/v1/runner/evaluation-jobs/claim", json_body={"runner_id": f"{self.runner_id}-evaluation", "lease_seconds": self.lease_seconds}).get("data")
        if claim is None:
            _log_event("sampling_runner_idle", runner_id=self.runner_id)
            return {"status": "idle"}
        job, lease = claim["job"], claim["lease_token"]
        job_id = str(job["id"])
        self._progress = {"stage": "resolving_evaluation_inputs"}
        _log_event("evaluation_job_claimed", job_id=job_id, attempt_count=job.get("attempt_count"))
        stop, abort, cancelled = threading.Event(), threading.Event(), threading.Event()
        heartbeat = threading.Thread(target=self._heartbeat, args=(job_id, lease, stop, abort, cancelled, "evaluation"), daemon=True)
        heartbeat.start()
        try:
            plan = self.control.request("GET", f"/api/internal/v1/runner/evaluation-jobs/{job_id}/inputs", lease=lease)["data"]
            total_bytes = sum(int(item["size_bytes"]) for item in [plan["model"], plan["ground_truth"], *plan["frames"]])
            if total_bytes > _setting_int("RUNNER_MAX_EVALUATION_BYTES", 512 * 1024 * 1024):
                raise RunnerError("evaluation input set exceeds the runner storage budget")
            if any(int(frame["width"]) * int(frame["height"]) > _setting_int("RUNNER_MAX_FRAME_PIXELS", 3840 * 2160) for frame in plan["frames"]):
                raise RunnerError("evaluation frame exceeds the runner pixel budget")
            script_candidates = [
                Path("/app/scripts/diagnostics/evaluate-frame-objects.py"),
                Path(__file__).resolve().parents[2] / "scripts" / "diagnostics" / "evaluate-frame-objects.py",
            ]
            script_path = next((path for path in script_candidates if path.is_file()), None)
            if script_path is None:
                raise RunnerError("managed object evaluation engine is not installed")
            implementation = "managed-object-evaluation.v1@sha256:" + hashlib.sha256(script_path.read_bytes()).hexdigest()
            if plan["implementation_version"] != implementation:
                raise RunnerError("runner engine source does not match the frozen evaluation implementation")
            spec = importlib.util.spec_from_file_location("managed_object_evaluation_engine", script_path)
            if spec is None or spec.loader is None:
                raise RunnerError("managed object evaluation engine could not be loaded")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            with tempfile.TemporaryDirectory(prefix=f"evaluation-{job_id}-") as directory:
                root = Path(directory)
                def download_input(item: dict[str, Any], filename: str) -> Path:
                    if abort.is_set():
                        raise RunnerError("evaluation cancelled or heartbeat lease lost")
                    payload = self.control.download(item["download_path"], lease=lease)
                    if len(payload) != int(item["size_bytes"]) or hashlib.sha256(payload).hexdigest() != item["sha256"]:
                        raise RunnerError("evaluation input size or checksum does not match its registration")
                    path = root / filename
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(payload)
                    return path

                model_path = download_input(plan["model"], "model.onnx")
                truth_path = download_input(plan["ground_truth"], "ground-truth.json")
                ground_truth = json.loads(truth_path.read_text(encoding="utf-8"))
                records = []
                for index, frame in enumerate(plan["frames"]):
                    path = download_input(frame, f"frames/{index:04d}.image")
                    records.append({"source_id": frame["source_id"], "frame_id": frame["frame_id"], "timestamp_sec": frame["timestamp_seconds"], "path": str(path), "sha256": frame["sha256"]})
                if abort.is_set():
                    raise RunnerError("evaluation cancelled or heartbeat lease lost")
                thresholds = plan["configuration"]
                self._progress = {"stage": "inference", "frame_count": len(records)}
                metrics = module.evaluate_managed_ground_truth(
                    model_path, records, ground_truth,
                    float(thresholds["minimum_confidence"]),
                    float(thresholds["nms_threshold"]),
                    float(thresholds["minimum_iou"]),
                    should_abort=abort.is_set,
                )
                report = {
                    "schema_version": "managed-evaluation-report.v1",
                    "evaluation_run_id": plan["evaluation_run_id"],
                    "input_sha256": plan["input_sha256"],
                    "implementation_version": plan["implementation_version"],
                    "model_sha256": plan["model"]["sha256"],
                    "ground_truth_sha256": plan["ground_truth"]["sha256"],
                    "metrics": metrics,
                    "logs": [
                        {"event": "evaluation.claimed", "attempt": job.get("attempt_count")},
                        {"event": "evaluation.completed", "duration_ms": round((time.monotonic() - started_at) * 1000), "frame_count": len(records)},
                    ],
                }
                result = self.control.request("POST", f"/api/internal/v1/runner/evaluation-jobs/{job_id}/complete", lease=lease, json_body=report)
            _log_event("evaluation_job_succeeded", job_id=job_id, frame_count=metrics["frame_count"], report_sha256=result["data"].get("report_sha256"))
            return {"status": "succeeded", "job_id": job_id, "evaluation_run_id": plan["evaluation_run_id"]}
        except Exception as exc:
            _log_event("evaluation_job_failed", job_id=job_id, error_type=type(exc).__name__)
            try:
                self.control.request("POST", f"/api/internal/v1/runner/evaluation-jobs/{job_id}/fail", lease=lease, json_body={"error_message": str(exc)[:2000], "requeue": not cancelled.is_set()})
            except Exception as report_error:
                _log_event("evaluation_failure_report_failed", job_id=job_id, error_type=type(report_error).__name__)
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
