"""@type test
@purpose Verify object-detection geometry, manifest safety, and report aggregation.
"""

import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "diagnostics" / "evaluate-frame-objects.py"
SPEC = importlib.util.spec_from_file_location("evaluate_frame_objects", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
objects = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = objects
SPEC.loader.exec_module(objects)


def test_letterbox_and_box_mapping_preserve_source_coordinates() -> None:
    """Map model detections back across padding without stretching the frame."""
    image = np.zeros((100, 200, 3), dtype=np.uint8)

    prepared, transform = objects.letterbox(image, 416)

    assert prepared.shape == (416, 416, 3)
    assert transform == objects.LetterboxTransform(104, 0, 208, 416, 100, 200)
    assert objects.map_box_to_source((104, 125, 312, 291), transform) == (
        50,
        10,
        100,
        80,
    )


def test_evaluate_strategy_retains_detections_and_latency(tmp_path: Path) -> None:
    """Aggregate per-frame evidence without hiding detector timing or classes."""
    strategy = tmp_path / "hybrid"
    frames = strategy / "frames"
    frames.mkdir(parents=True)
    assert cv2.imwrite(str(frames / "frame.jpg"), np.zeros((20, 40, 3), dtype=np.uint8))
    (strategy / "manifest.csv").write_text(
        "filename,timestamp_sec,sampling_reasons\nframe.jpg,1.25,interval\n",
        encoding="utf-8",
    )

    report = objects.evaluate_strategy(
        strategy,
        lambda _image: ([objects.ObjectObservation("person", 0.9, (1, 2, 3, 4))], 5.25),
        {1.25: [objects.ObjectLabel("person", (1, 2, 3, 4))]},
    )

    assert report["frame_count"] == 1
    assert report["frames_with_objects"] == 1
    assert report["class_counts"] == {"person": 1}
    assert report["mean_inference_ms"] == 5.25
    assert report["p95_inference_ms"] == 5.25
    assert report["object_precision"] == 1.0
    assert report["object_recall"] == 1.0
    assert report["object_f1"] == 1.0
    assert report["frames"][0]["observations"][0]["region"] == (1, 2, 3, 4)


def test_evaluate_strategy_rejects_manifest_path_escape(tmp_path: Path) -> None:
    """Do not let diagnostic manifests read arbitrary files outside frame roots."""
    strategy = tmp_path / "hybrid"
    (strategy / "frames").mkdir(parents=True)
    (strategy / "manifest.csv").write_text(
        "filename,timestamp_sec,sampling_reasons\n../../outside.jpg,1.25,interval\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="escapes frame root"):
        objects.evaluate_strategy(strategy, lambda _image: ([], 1.0))


def test_score_observations_requires_class_and_iou_match() -> None:
    """Match each expected object once and penalize duplicate or wrong-class boxes."""
    expected = [objects.ObjectLabel("person", (0, 0, 100, 100))]
    observed = [
        objects.ObjectObservation("person", 0.9, (0, 0, 100, 100)),
        objects.ObjectObservation("person", 0.8, (5, 5, 90, 90)),
        objects.ObjectObservation("tv", 0.7, (0, 0, 100, 100)),
    ]

    assert objects.score_observations(expected, observed, 0.5) == (1, 2, 0)
    assert objects.score_observations(expected, observed[2:], 0.5) == (0, 1, 1)


def test_score_observations_maximizes_one_to_one_matches() -> None:
    """Do not lose a true positive when the highest-IoU pair blocks two matches."""
    expected = [
        objects.ObjectLabel("person", (0, 0, 100, 100)),
        objects.ObjectLabel("person", (40, 0, 100, 100)),
    ]
    observed = [
        objects.ObjectObservation("person", 0.9, (20, 0, 100, 100)),
        objects.ObjectObservation("person", 0.8, (0, 0, 70, 100)),
    ]

    assert objects.score_observations(expected, observed, 0.5) == (2, 0, 0)


def test_checksum_bound_ground_truth_rejects_different_source(tmp_path: Path) -> None:
    """Never score object annotations against frames from another source video."""
    sampling = tmp_path / "sampling"
    sampling.mkdir()
    (sampling / "report.json").write_text(
        json.dumps({"source_sha256": "different"}), encoding="utf-8"
    )
    truth = tmp_path / "truth.json"
    truth.write_text(json.dumps({"source_sha256": "expected", "frames": []}), encoding="utf-8")

    with pytest.raises(RuntimeError, match="does not match"):
        objects.load_ground_truth(truth, sampling)
