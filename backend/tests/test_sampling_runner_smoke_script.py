"""@type test @purpose Verify deployed sampling-runner smoke-test orchestration."""

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[2] / "scripts" / "operations" / "smoke-test-sampling-runner.py"
SPEC = importlib.util.spec_from_file_location("sampling_runner_smoke", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class FakeClient:
    def __init__(self, terminal_status: str = "succeeded") -> None:
        self.terminal_status = terminal_status
        self.calls: list[tuple[str, str, object | None]] = []
        self.evidence = b"jpeg evidence"
        self.sha256 = hashlib.sha256(self.evidence).hexdigest()

    def request(self, method: str, path: str, payload: object | None = None):
        self.calls.append((method, path, payload))
        if path == "/api/internal/v1/datasets":
            return {"data": {"id": "ds_1", "initial_version": {"id": "dsv_1"}}}, {}
        if path == "/api/internal/v1/sampling-jobs":
            return {"data": {"id": "job_1", "status": "queued"}}, {}
        if path == "/api/internal/v1/sampling-jobs/job_1":
            output = {"frame_set_id": "fs_1"} if self.terminal_status == "succeeded" else None
            return {"data": {"id": "job_1", "status": self.terminal_status, "attempt_count": 1, "heartbeat_at": "now", "output": output, "error_message": "download failed"}}, {}
        if path == "/api/internal/v1/frame-sets/fs_1":
            return {"data": {"id": "fs_1", "status": "ready", "sources": [{"dataset_source_id": "src_1"}], "frames": [{"id": "frame_1", "artifact": {"sha256": self.sha256, "size_bytes": len(self.evidence)}}]}}, {}
        if path == "/api/internal/v1/frame-sets/fs_1/manifest":
            return json.dumps({"frame_set_id": "fs_1", "sampling_job_id": "job_1", "source_count": 1, "frame_count": 1}).encode(), {"etag": "manifest"}
        if path == "/api/internal/v1/frame-sets/fs_1/frames/frame_1/evidence":
            return self.evidence, {"content-type": "image/jpeg"}
        raise AssertionError((method, path, payload))


def test_smoke_test_verifies_completed_artifacts(monkeypatch) -> None:
    monkeypatch.setattr(smoke.time, "time", lambda: 1234)
    client = FakeClient()

    report = smoke.run_smoke_test(
        client,
        "https://media.example/sample.mp4",
        poll_interval_seconds=0,
        timeout_seconds=30,
        sleep=lambda _seconds: None,
        progress=lambda _message: None,
    )

    assert report["status"] == "passed"
    assert report["frame_set_id"] == "fs_1"
    assert report["evidence_sha256"] == client.sha256
    create_job = next(call for call in client.calls if call[1] == "/api/internal/v1/sampling-jobs")
    assert create_job[2]["idempotency_key"] == "sampling-runner-smoke-1234"


def test_smoke_test_reports_terminal_failure(monkeypatch) -> None:
    monkeypatch.setattr(smoke.time, "time", lambda: 1234)

    with pytest.raises(smoke.SmokeTestError, match="ended as failed: download failed"):
        smoke.run_smoke_test(
            FakeClient("failed"),
            "https://media.example/sample.mp4",
            poll_interval_seconds=0,
            timeout_seconds=30,
            sleep=lambda _seconds: None,
            progress=lambda _message: None,
        )
