"""@type test @purpose Verify real visual evidence and fail-closed governed Product execution."""

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from video_semantic_extractor.api import create_app
from video_semantic_extractor.engine_identity import evaluation_implementation
from video_semantic_extractor.pipeline import CapsuleBuilder
from video_semantic_extractor.product_execution import ProductNotReady, configured_builder
from video_semantic_extractor.visual import VisualAnalyzer


def test_real_video_ocr_preserves_late_visual_facts_and_evidence(tmp_path):
    video = tmp_path / "facts.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=960x540:r=5:d=3",
            "-vf",
            "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='SAFETY CHECK':fontsize=60:fontcolor=black:x=60:y=180:enable='lt(t,1.5)',drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='VALVE CLOSED':fontsize=60:fontcolor=black:x=60:y=180:enable='gte(t,1.5)'",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        check=True,
        timeout=30,
    )
    builder = CapsuleBuilder(
        frame_analyzer=VisualAnalyzer(), sampling_interval_sec=1, max_keyframes=10
    )
    builder.execution = {"mode": "ocr"}
    capsule = builder.build(video)
    assert capsule.version == "1.1"
    assert not capsule.transcript.segments
    assert any("SAFETY CHECK" in " ".join(frame.text_in_frame) for frame in capsule.keyframes)
    assert any(
        "VALVE CLOSED" in " ".join(frame.text_in_frame)
        for frame in capsule.keyframes
        if frame.timestamp_sec >= 1.5
    )
    for event in capsule.timeline:
        assert event.event_type == "visible_text"
        index = int(event.evidence[0].split("[")[1].split("]")[0])
        assert capsule.keyframes[index].timestamp_sec == event.start_sec
        assert capsule.keyframes[index].text_observations
    for frame in capsule.keyframes:
        for observation in frame.text_observations:
            x, y, w, h = observation.region
            assert 0 <= x < x + w <= 960 and 0 <= y < y + h <= 540
    assert not capsule.scene_graph.relations
    assert all(not frame.actions for frame in capsule.keyframes)


def execution_plan():
    root = Path(__file__).parents[2]
    package = root / "backend/video_semantic_extractor"
    sampler = hashlib.sha256(
        b"pipeline.py\0"
        + (package / "pipeline.py").read_bytes()
        + b"sampling_runner.py\0"
        + (package / "sampling_runner.py").read_bytes()
    ).hexdigest()
    model_id = "mv_" + "a" * 32
    config = json.dumps(
        {
            "schema_version": "pipeline-release.v1",
            "model_version_id": model_id,
            "components": {
                "sampler": "video-semantic-extractor@1.0.0@sha256:" + sampler,
                "evaluator": evaluation_implementation(
                    root / "scripts/diagnostics/evaluate-frame-objects.py"
                ),
                "annotation_schema": "object-annotations.v1",
            },
            "thresholds": {"minimum_confidence": 0.35, "nms_threshold": 0.6, "minimum_iou": 0.5},
        }
    )
    model = b"unit-test model bytes; inference is separately exercised with the real pinned ONNX"
    return {
        "schema_version": "product-execution.v1",
        "release_id": "release_" + "b" * 32,
        "release_revision": 3,
        "evaluation_run_id": "evaluation_" + "c" * 32,
        "configuration_json": config,
        "configuration_sha256": hashlib.sha256(config.encode()).hexdigest(),
        "model": {
            "id": model_id,
            "architecture": "nanodet-plus-1.5x-416",
            "sha256": hashlib.sha256(model).hexdigest(),
            "size_bytes": len(model),
            "download_path": f"/api/internal/v1/models/{model_id}/artifact",
        },
    }, model


def session_stub(monkeypatch, plan, model, status=200):
    class Response:
        status_code = status

        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def iter_content(self, *_):
            return iter([self.payload])

    class Session:
        def __init__(self):
            self.headers = {}
            self.calls = []

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def get(self, url, **kwargs):
            self.calls.append(url)
            assert url.startswith("https://control.example/api/internal/v1/")
            assert kwargs["allow_redirects"] is False
            return Response(
                json.dumps({"data": plan}).encode() if url.endswith("/execution") else model
            )

    monkeypatch.setenv("CAPSULE_VISUAL_MODE", "governed")
    monkeypatch.setenv("CAPSULE_CONTROL_PLANE_URL", "https://control.example")
    monkeypatch.setenv("CAPSULE_CONTROL_PLANE_TOKEN", "test-service-credential")
    monkeypatch.setattr("video_semantic_extractor.product_execution.requests.Session", Session)
    return Session


@pytest.mark.parametrize(
    "damage", ["configuration", "model", "engine", "download_path", "redirect"]
)
def test_governed_execution_rejects_changed_inputs(monkeypatch, damage):
    plan, model = execution_plan()
    if damage == "configuration":
        plan["configuration_sha256"] = "0" * 64
    if damage == "model":
        model += b"changed"
    if damage == "engine":
        config = json.loads(plan["configuration_json"])
        config["components"]["evaluator"] = "old-engine"
        plan["configuration_json"] = json.dumps(config)
        plan["configuration_sha256"] = hashlib.sha256(
            plan["configuration_json"].encode()
        ).hexdigest()
    if damage == "download_path":
        plan["model"]["download_path"] = "https://different.example/model"
    session_stub(monkeypatch, plan, model, 302 if damage == "redirect" else 200)
    with pytest.raises(ProductNotReady), configured_builder():
        pytest.fail("Invalid release must not execute")


def test_governed_execution_pins_release_and_removes_temporary_model(monkeypatch):
    plan, model = execution_plan()
    session_stub(monkeypatch, plan, model)
    model_paths = []

    def analyzer(path, **kwargs):
        model_paths.append(path)
        assert path.read_bytes() == model
        assert kwargs == {"confidence": 0.35, "nms": 0.6}
        result = lambda *_: None
        result.ocr_version = "test-tesseract"
        return result

    monkeypatch.setattr("video_semantic_extractor.product_execution.VisualAnalyzer", analyzer)
    with configured_builder() as builder:
        assert builder.execution["release_id"] == plan["release_id"]
        assert builder.execution["model_sha256"] == plan["model"]["sha256"]
    assert not model_paths[0].exists()


def test_no_approved_release_returns_503_before_fetching_media(monkeypatch):
    plan, model = execution_plan()
    session_stub(monkeypatch, plan, model, 409)
    monkeypatch.setattr(
        "video_semantic_extractor.api.download_video",
        lambda *_: pytest.fail("Do not fetch media without eligible release inputs"),
    )
    response = TestClient(create_app()).post(
        "/capsule", json={"video_url": "https://media.example/video.mp4"}
    )
    assert response.status_code == 503
    assert "test-service-credential" not in response.text
