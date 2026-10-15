"""@type test @purpose Verify sampling-runner dispatch and artifact registration."""

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from video_semantic_extractor.pipeline import FrameCandidate
from video_semantic_extractor.sampling_runner import ControlPlaneClient, RunnerError, SamplingRunner, _log_event, _source_frame_limit, create_runner_app


class StubRunner:
    def __init__(self) -> None:
        self.calls = 0

    def run_once(self) -> dict[str, str]:
        self.calls += 1
        return {"status": "idle"}


def test_evaluation_download_is_bounded_and_closes_the_response(monkeypatch) -> None:
    closed = []
    response = SimpleNamespace(ok=True, iter_content=lambda **_: iter([b"abc", b"def"]), close=lambda: closed.append(True))
    monkeypatch.setattr("video_semantic_extractor.sampling_runner.requests.get", lambda *args, **kwargs: response)
    with pytest.raises(RunnerError, match="bounded download"):
        ControlPlaneClient().download("/input", lease="lease", maximum_bytes=5)
    assert closed == [True]


def test_runner_events_are_written_as_json_to_stdout(capsys) -> None:
    _log_event("sampling_runner_test", job_id="job_1")

    assert json.loads(capsys.readouterr().out) == {
        "event": "sampling_runner_test",
        "job_id": "job_1",
    }


def test_runner_health_and_single_dispatch() -> None:
    runner = StubRunner()
    app = create_runner_app(runner)
    endpoints = {route.path: route.endpoint for route in app.routes if hasattr(route, "endpoint")}

    assert endpoints["/health"]() == {"status": "ok"}
    assert endpoints["/run-once"]() == {"status": "idle"}
    assert runner.calls == 1


def test_runner_uploads_frames_and_finalizes_manifest(monkeypatch) -> None:
    class FakeControl:
        manifest = None
        uploaded = b""

        def request(self, method, path, **kwargs):
            if path.endswith("/claim"):
                return {"data": {"job": {"id": "job_1", "input": {"dataset_version_id": "dsv_1", "method": "hybrid", "scene_threshold": 0.3, "interval_seconds": 5, "max_frames": 10, "include_final_frame": True}}, "lease_token": "lease", "frame_set_id": "frameset_1"}}
            if path.endswith("/sources"):
                return {"data": {"sources": [{"id": "src_1", "url": "https://media.example/video.mp4", "ordinal": 0}]}}
            if path.endswith("/artifacts") and method == "POST":
                return {"data": {"id": "artifact_1", "upload_path": "/upload/artifact_1"}}
            if path == "/upload/artifact_1":
                self.uploaded = kwargs["data"]
                return {"data": {"status": "uploaded"}}
            if path.endswith("/finalize"):
                self.manifest = kwargs["json_body"]["manifest"]
                return {"data": {"id": "frameset_1", "status": "ready"}}
            raise AssertionError((method, path))

    def fake_download(_url: str, destination: Path, _max_bytes: int, _timeout: int) -> None:
        destination.write_bytes(b"video")

    def fake_candidates(_video: Path, output: Path, _config, _duration, _should_abort=None):
        output.mkdir(parents=True)
        frame = output / "frame.jpg"
        frame.write_bytes(b"jpeg")
        return [FrameCandidate(frame, 1.25, ("near_final",))]

    monkeypatch.setattr("video_semantic_extractor.sampling_runner.download_video", fake_download)
    monkeypatch.setattr("video_semantic_extractor.sampling_runner.probe_video", lambda _path: SimpleNamespace(duration_sec=10.0, width=320, height=180))
    monkeypatch.setattr("video_semantic_extractor.sampling_runner._candidates", fake_candidates)
    monkeypatch.setattr("video_semantic_extractor.sampling_runner.cv2.imread", lambda _path: np.zeros((360, 640, 3)))
    control = FakeControl()
    runner = SamplingRunner(control)  # type: ignore[arg-type]

    result = runner.run_once()

    assert result["status"] == "succeeded"
    assert control.uploaded == b"jpeg"
    assert control.manifest["source_count"] == 1
    assert control.manifest["frame_count"] == 1
    assert control.manifest["sources"][0]["frames"][0]["artifact"]["artifact_id"] == "artifact_1"
    assert control.manifest["sources"][0]["frames"][0]["reasons"] == ["near_final"]


def test_source_frame_limit_preserves_a_global_budget_and_each_source() -> None:
    remaining = 500
    limits = []
    for sources_left in (3, 2, 1):
        limit = _source_frame_limit(250, remaining, sources_left)
        limits.append(limit)
        remaining -= limit

    assert limits == [167, 167, 166]
    assert sum(limits) == 500


def test_source_frame_limit_rejects_impossible_source_coverage() -> None:
    with pytest.raises(RunnerError, match="at least one frame per source"):
        _source_frame_limit(250, 1, 2)
