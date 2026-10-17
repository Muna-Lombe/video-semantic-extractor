"""@type test @purpose Validate native COCO matching, crowd handling and prediction-blind subset selection."""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts/diagnostics/benchmark-corpus.py"
SPEC = importlib.util.spec_from_file_location("corpus_benchmark", SCRIPT)
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


def native():
    return {
        "info": {},
        "images": [
            {"id": 1, "width": 100, "height": 100},
            {"id": 2, "width": 100, "height": 100},
            {"id": 3, "width": 100, "height": 100},
        ],
        "categories": [{"id": 1, "name": "person"}, {"id": 3, "name": "car"}],
        "annotations": [
            {
                "id": 1,
                "image_id": 1,
                "category_id": 1,
                "bbox": [0, 0, 20, 20],
                "area": 400,
                "iscrowd": 0,
            },
            {
                "id": 2,
                "image_id": 3,
                "category_id": 1,
                "bbox": [0, 0, 100, 100],
                "area": 10000,
                "iscrowd": 1,
            },
        ],
    }


def test_native_scoring_handles_empty_frames_duplicates_and_crowds():
    predictions = [
        {"image_id": 1, "category_id": 1, "bbox": [0, 0, 20, 20], "score": 0.99},
        {"image_id": 1, "category_id": 1, "bbox": [0, 0, 20, 20], "score": 0.98},
        {"image_id": 2, "category_id": 1, "bbox": [0, 0, 20, 20], "score": 0.97},
        {"image_id": 3, "category_id": 1, "bbox": [0, 0, 10, 10], "score": 0.96},
    ]
    result = benchmark.score_coco(native(), predictions, [1, 2, 3], 0.35)
    assert result["true_positives"] == 1
    assert result["false_positives"] == 2
    assert result["false_negatives"] == 0
    assert result["precision_at_035"] == pytest.approx(1 / 3)
    assert result["classes"]["car"]["ap_50_95"] is None


def test_no_predictions_is_a_valid_failed_detection_result():
    result = benchmark.score_coco(native(), [], [1, 2, 3], 0.35)
    assert result["map_50_95"] == 0
    assert result["false_negatives"] == 1
    assert result["recall_at_035"] == 0
    assert result["precision_at_035"] is None


def test_subset_is_reproducible_and_prioritizes_independent_class_support():
    images = [{"id": i} for i in range(10)]
    annotations = [{"image_id": i, "category_id": 1} for i in range(9)] + [
        {"image_id": 9, "category_id": 2}
    ]
    selected = benchmark.select_images(images, annotations, 3, "seed")
    assert selected == benchmark.select_images(images, annotations, 3, "seed")
    assert len(set(selected)) == 3
    assert 9 in selected
    with pytest.raises(ValueError):
        benchmark.select_images(images, annotations, 11, "seed")
