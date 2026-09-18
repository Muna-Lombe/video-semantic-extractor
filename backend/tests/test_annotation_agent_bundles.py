"""@type test
@purpose Verify per-video agent bundle export and JSONC handoff shape.
"""

import importlib.util
import json
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "annotation-review" / "export-agent-bundles.py"
SPEC = importlib.util.spec_from_file_location("export_agent_bundles", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def test_exports_one_bundle_with_schema_readme_and_frames(tmp_path: Path) -> None:
    sampling = tmp_path / "sampling" / "sample_1" / "hybrid" / "frames"
    sampling.mkdir(parents=True)
    (sampling / "frame.jpg").write_bytes(b"frame")
    annotations = tmp_path / "annotations.json"
    annotations.write_text(json.dumps({
        "sources": [{
            "source": "sample_1.mp4",
            "source_sha256": "a" * 64,
            "frames": [{"filename": "frame.jpg", "timestamp_sec": 1.25, "objects": [], "out_of_taxonomy": []}],
        }],
    }), encoding="utf-8")

    bundles = exporter.export_bundles(annotations, tmp_path / "sampling", tmp_path / "bundles")

    assert len(bundles) == 1
    with zipfile.ZipFile(bundles[0]) as archive:
        assert set(archive.namelist()) == {"README.md", "schema.json", "annotations.jsonc", "frames/frame.jpg"}
        handoff = json.loads(archive.read("annotations.jsonc"))
        assert handoff["source_sha256"] == "a" * 64
        assert handoff["frames"][0]["filename"] == "frame.jpg"
        assert "prediction-blind" in archive.read("README.md").decode().lower()