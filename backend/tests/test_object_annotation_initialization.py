"""@type test
@purpose Verify prediction-blind object annotation fixture initialization.
"""

import csv
import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "diagnostics" / "initialize-object-annotations.py"
SPEC = importlib.util.spec_from_file_location("initialize_object_annotations", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
initializer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = initializer
SPEC.loader.exec_module(initializer)


def create_sampling_evidence(root: Path) -> None:
    """Create checksum-bound manifests for all policy-required sources."""
    for index in range(1, 6):
        sampling = root / f"sample_{index}"
        (sampling / "hybrid").mkdir(parents=True)
        (sampling / "report.json").write_text(
            json.dumps({"source_sha256": f"{index}" * 64}), encoding="utf-8"
        )
        with (sampling / "hybrid" / "manifest.csv").open(
            "w", newline="", encoding="utf-8"
        ) as handle:
            writer = csv.writer(handle)
            writer.writerow(("filename", "timestamp_sec", "sampling_reasons"))
            writer.writerow((f"frame_{index}.jpg", f"{index}.25", "interval"))


def test_initializer_covers_every_source_and_frame_without_claiming_review(
    tmp_path: Path,
) -> None:
    """Start from empty lists while keeping all human review incomplete."""
    create_sampling_evidence(tmp_path)

    payload = initializer.initialize_annotations(tmp_path)

    assert payload["review"] == {
        "independent_passes": 0,
        "predictions_reviewed_before_freeze": False,
        "adjudication_status": "not_started",
        "adjudication_log": [],
    }
    assert [source["source"] for source in payload["sources"]] == [
        f"sample_{index}.mp4" for index in range(1, 6)
    ]
    assert payload["sources"][2]["frames"] == [
        {
            "filename": "frame_3.jpg",
            "timestamp_sec": 3.25,
            "objects": [],
            "out_of_taxonomy": [],
        }
    ]


def test_initializer_rejects_a_manifest_path_escape(tmp_path: Path) -> None:
    """Do not place an unsafe evidence path into a reviewer fixture."""
    create_sampling_evidence(tmp_path)
    manifest = tmp_path / "sample_4" / "hybrid" / "manifest.csv"
    manifest.write_text(
        "filename,timestamp_sec,sampling_reasons\n../frame.jpg,1.0,interval\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="unsafe, missing, or duplicate"):
        initializer.initialize_annotations(tmp_path)
