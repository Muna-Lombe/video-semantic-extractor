"""@type test
@purpose Verify the local annotation review server saves metadata safely.
"""

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "annotation-review" / "server.py"
SPEC = importlib.util.spec_from_file_location("annotation_review_server", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
server_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_module)


def create_review(tmp_path: Path) -> tuple[Path, Path, dict[str, object]]:
    sampling = tmp_path / "sampling"
    frames = sampling / "sample_1" / "hybrid" / "frames"
    frames.mkdir(parents=True)
    (frames / "frame.jpg").write_bytes(b"not-an-image")
    payload = {
        "policy_version": "2026-09-18",
        "review": {
            "independent_passes": 0,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "not_started",
            "adjudication_log": [],
        },
        "sources": [
            {
                "source": "sample_1.mp4",
                "source_sha256": "a" * 64,
                "frames": [
                    {
                        "filename": "frame.jpg",
                        "timestamp_sec": 1.0,
                        "objects": [],
                        "out_of_taxonomy": [],
                    }
                ],
            }
        ],
    }
    annotation_path = tmp_path / "review.json"
    annotation_path.write_text(json.dumps(payload), encoding="utf-8")
    return sampling, annotation_path, payload


def request_json(url: str, payload: dict[str, object] | None = None) -> tuple[int, dict[str, object]]:
    request = urllib.request.Request(url, method="POST" if payload else "GET")
    if payload:
        body = json.dumps(payload).encode("utf-8")
        request.data = body
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_review_server_loads_and_saves_without_allowing_identity_changes(tmp_path: Path) -> None:
    sampling, annotation_path, payload = create_review(tmp_path)
    review_root = SCRIPT.parent / "web"
    server = server_module.ReviewServer(
        ("127.0.0.1", 0),
        server_module.ReviewHandler,
        review_root,
        annotation_path,
        sampling,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        status, state = request_json(f"{base_url}/api/state")
        assert status == 200
        assert state["annotations"] == payload

        changed = json.loads(json.dumps(payload))
        changed["review"]["independent_passes"] = 1
        status, _ = request_json(f"{base_url}/api/save", changed)
        assert status == 200
        assert json.loads(annotation_path.read_text(encoding="utf-8"))["review"]["independent_passes"] == 1

        changed["sources"][0]["source_sha256"] = "b" * 64
        status, result = request_json(f"{base_url}/api/save", changed)
        assert status == 400
        assert "identity" in result["error"]
    finally:
        server.shutdown()
        server.server_close()


def test_review_server_imports_jsonc_without_changing_review_status(tmp_path: Path) -> None:
    sampling, annotation_path, payload = create_review(tmp_path)
    server = server_module.ReviewServer(
        ("127.0.0.1", 0), server_module.ReviewHandler, SCRIPT.parent / "web", annotation_path, sampling
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        response = {
            "source": "sample_1.mp4",
            "source_sha256": "a" * 64,
            "frames": [{
                "filename": "frame.jpg",
                "timestamp_sec": 1.0,
                "objects": [{"id": "agent-1", "label": "person", "subset": "live", "region": [1, 2, 20, 20]}],
                "out_of_taxonomy": [],
            }],
        }
        status, _ = request_json(
            f"{base_url}/api/import-agent",
            {"content": "// reviewed" + chr(10) + json.dumps(response)[:-1] + "," + chr(10) + "}"},
        )
        assert status == 200
        saved = json.loads(annotation_path.read_text(encoding="utf-8"))
        assert saved["sources"][0]["frames"][0]["objects"][0]["id"] == "agent-1"
        assert saved["review"]["independent_passes"] == 0
    finally:
        server.shutdown()
        server.server_close()