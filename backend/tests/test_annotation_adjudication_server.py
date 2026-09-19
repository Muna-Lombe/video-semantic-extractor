"""@type test
@purpose Verify isolated adjudicator state, decisions, and completion gates.
"""

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "annotation-review" / "adjudication-server.py"
SPEC = importlib.util.spec_from_file_location("annotation_adjudication_server", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def payload(label: str) -> dict[str, object]:
    return {
        "policy_version": "2026-09-18",
        "review": {
            "independent_passes": 1,
            "adjudication_status": "not_started",
            "adjudication_log": [],
            "manual_pass": {"status": "complete", "completed_at": "2026-09-19T00:00:00Z"},
        },
        "sources": [{
            "source": "sample_1.mp4", "source_sha256": "a" * 64,
            "frames": [{"filename": "frame.jpg", "timestamp_sec": 1.0,
                        "objects": [{"id": 1, "label": label, "subset": "live", "region": [1, 2, 20, 30]}],
                        "out_of_taxonomy": []}],
        }],
    }


def post(url: str, value: dict[str, object]) -> tuple[int, dict[str, object]]:
    request = urllib.request.Request(url, data=json.dumps(value).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_adjudicator_isolated_output_and_completion_gate(tmp_path: Path) -> None:
    left, right, output = (tmp_path / name for name in ("a.json", "b.json", "merged.json"))
    left.write_text(json.dumps(payload("person")), encoding="utf-8")
    right.write_text(json.dumps(payload("chair")), encoding="utf-8")
    frames = tmp_path / "sampling" / "sample_1" / "hybrid" / "frames"
    frames.mkdir(parents=True)
    (frames / "frame.jpg").write_bytes(b"image")
    server = module.AdjudicationServer(("127.0.0.1", 0), module.AdjudicationHandler,
        SCRIPT.with_name("adjudication-web"), left, right, output, tmp_path / "sampling")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with urllib.request.urlopen(f"{base}/api/state") as response:
            state = json.loads(response.read())
        assert state["workspace"] == "adjudicator-c"
        assert len(state["comparison"]["disagreements"]) == 2
        assert _read(left)["review"]["adjudication_status"] == "not_started"
        status, result = post(f"{base}/api/complete", {})
        assert status == 400 and "resolve every" in result["error"]
        frame = state["reviewer_a"]["sources"][0]["frames"][0]
        status, _ = post(f"{base}/api/resolve", {"source": "sample_1.mp4", "filename": "frame.jpg", "frame": frame, "resolution": "reviewer_a"})
        assert status == 200
        status, _ = post(f"{base}/api/complete", {})
        assert status == 200
        assert _read(output)["review"]["adjudication_status"] == "complete"
        assert _read(left)["review"]["adjudication_status"] == "not_started"
        assert _read(right)["review"]["adjudication_status"] == "not_started"
    finally:
        server.shutdown()
        server.server_close()


def _read(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))
