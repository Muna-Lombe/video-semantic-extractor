"""@type test
@purpose Verify multi-video annotation identity, coverage, geometry, and policy gates.
"""

import csv
import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np

SCRIPT = (
    Path(__file__).parents[2]
    / "scripts"
    / "diagnostics"
    / "validate-object-annotations.py"
)
SPEC = importlib.util.spec_from_file_location("validate_object_annotations", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = validator
SPEC.loader.exec_module(validator)


def create_sampling_evidence(root: Path, sample: str = "sample_1") -> None:
    """Create one checksum-bound hybrid manifest and decodable source frame."""
    sampling = root / sample
    frames = sampling / "hybrid" / "frames"
    frames.mkdir(parents=True)
    (sampling / "report.json").write_text(
        json.dumps({"source_sha256": "a" * 64}), encoding="utf-8"
    )
    with (sampling / "hybrid" / "manifest.csv").open(
        "w", newline="", encoding="utf-8"
    ) as handle:
        writer = csv.writer(handle)
        writer.writerow(("filename", "timestamp_sec", "sampling_reasons"))
        writer.writerow(("frame.jpg", "1.25", "interval"))
    assert cv2.imwrite(
        str(frames / "frame.jpg"), np.zeros((100, 200, 3), dtype=np.uint8)
    )


def valid_payload() -> dict[str, object]:
    """Return a structurally valid but deliberately underpowered annotation set."""
    return {
        "policy_version": "2026-09-18",
        "review": {
            "independent_passes": 2,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "complete",
            "adjudication_log": [],
        },
        "sources": [
            {
                "source": "sample_1.mp4",
                "source_sha256": "a" * 64,
                "frames": [
                    {
                        "filename": "frame.jpg",
                        "timestamp_sec": 1.25,
                        "objects": [
                            {
                                "id": "sample-1-person-1",
                                "label": "person",
                                "subset": "live",
                                "region": [10, 10, 40, 50],
                            }
                        ],
                        "out_of_taxonomy": [],
                    }
                ],
            }
        ],
    }


def test_valid_annotations_can_fail_adequacy_without_becoming_invalid(
    tmp_path: Path,
) -> None:
    """Keep annotation defects distinct from a corpus that is still too narrow."""
    create_sampling_evidence(tmp_path)

    report = validator.validate_annotations(valid_payload(), tmp_path)

    assert report["valid"] is True
    assert report["adequate"] is False
    assert report["errors"] == []
    assert report["counts"]["objects"] == 1
    assert report["corpus_adequacy_gates"]["fifty_non_person_instances"] is False


def test_validation_rejects_evidence_mismatch_and_invalid_box(tmp_path: Path) -> None:
    """Reject annotations that are detached from evidence or exceed image bounds."""
    create_sampling_evidence(tmp_path)
    payload = valid_payload()
    payload["sources"][0]["source_sha256"] = "b" * 64
    payload["sources"][0]["frames"][0]["objects"][0]["region"] = [190, 10, 20, 20]

    report = validator.validate_annotations(payload, tmp_path)

    assert report["valid"] is False
    assert any("does not match sampling report" in error for error in report["errors"])
    assert any("region exceeds 200x100 frame" in error for error in report["errors"])


def test_validation_requires_exact_manifest_coverage(tmp_path: Path) -> None:
    """An omitted negative frame is a coverage error, not an implicit empty label."""
    create_sampling_evidence(tmp_path)
    payload = valid_payload()
    payload["sources"][0]["frames"] = []

    report = validator.validate_annotations(payload, tmp_path)

    assert report["valid"] is False
    assert report["counts"]["frames"] == 0
    assert any(
        "missing annotated frames: frame.jpg" in error for error in report["errors"]
    )
