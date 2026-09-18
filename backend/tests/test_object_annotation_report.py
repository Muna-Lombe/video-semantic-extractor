"""@type test
@purpose Verify reproducible annotation report and investigation record generation.
"""

import csv
import importlib.util
import json
from pathlib import Path

import cv2
import numpy as np


SCRIPT = (
    Path(__file__).parents[2] / "scripts" / "diagnostics" / "generate-object-annotation-report.py"
)
SPEC = importlib.util.spec_from_file_location("generate_object_annotation_report", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)


def test_report_contains_review_state_validation_and_hashes(tmp_path: Path) -> None:
    sampling = tmp_path / "sampling" / "sample_1" / "hybrid"
    frames = sampling / "frames"
    frames.mkdir(parents=True)
    (sampling.parent / "report.json").write_text(
        json.dumps({"source_sha256": "a" * 64}), encoding="utf-8"
    )
    with (sampling / "manifest.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(("filename", "timestamp_sec"))
        writer.writerow(("frame.jpg", "1.0"))
    assert cv2.imwrite(str(frames / "frame.jpg"), np.zeros((100, 100, 3), dtype=np.uint8))

    payload = {
        "policy_version": "2026-09-18",
        "review": {
            "independent_passes": 1,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "in_progress",
            "adjudication_log": [{"frame": "sample_1.mp4/frame.jpg"}],
            "reviewed_frames": ["sample_1.mp4/frame.jpg"],
            "manual_pass": {
                "status": "complete",
                "completed_at": "2026-09-18T12:00:00+00:00",
            },
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
    merged = tmp_path / "merged.json"
    reviewer = tmp_path / "reviewer-a.json"
    reviewer_b = tmp_path / "reviewer-b.json"
    merged.write_text(json.dumps(payload), encoding="utf-8")
    reviewer.write_text(json.dumps(payload), encoding="utf-8")
    reviewer_b.write_text(json.dumps(payload), encoding="utf-8")

    report, markdown = reporter.generate_report(
        merged, tmp_path / "sampling", [reviewer, reviewer_b]
    )

    assert len(report["merged_fixture"]["sha256"]) == 64
    assert report["review"]["independent_passes"] == 1
    assert report["review"]["adjudication_entries"] == 1
    assert report["validation"]["valid"] is True
    assert report["validation"]["adequate"] is False
    assert report["review_comparison"]["agree"] is True
    assert report["review_provenance"]["ready"] is True
    assert report["ready_for_detector_scoring"] is False
    assert "Corpus counts" in markdown
    assert "adjudication" in markdown.lower()


def test_report_rejects_duplicate_reviewer_input_as_provenance(tmp_path: Path) -> None:
    """The same saved pass cannot stand in for two independent reviewer files."""
    sampling = tmp_path / "sampling" / "sample_1" / "hybrid"
    frames = sampling / "frames"
    frames.mkdir(parents=True)
    (sampling.parent / "report.json").write_text(
        json.dumps({"source_sha256": "a" * 64}), encoding="utf-8"
    )
    with (sampling / "manifest.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(("filename", "timestamp_sec"))
        writer.writerow(("frame.jpg", "1.0"))
    assert cv2.imwrite(str(frames / "frame.jpg"), np.zeros((100, 100, 3), dtype=np.uint8))
    payload = {
        "policy_version": "2026-09-18",
        "review": {
            "independent_passes": 1,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "in_progress",
            "adjudication_log": [],
            "reviewed_frames": ["sample_1.mp4/frame.jpg"],
            "manual_pass": {"status": "complete", "completed_at": "2026-09-18T12:00:00Z"},
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
    reviewer = tmp_path / "reviewer.json"
    reviewer.write_text(json.dumps(payload), encoding="utf-8")

    report, _markdown = reporter.generate_report(
        reviewer, tmp_path / "sampling", [reviewer, reviewer]
    )

    assert report["review_provenance"]["distinct_inputs"] is False
    assert report["review_provenance"]["ready"] is False
