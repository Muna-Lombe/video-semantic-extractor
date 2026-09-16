"""@type test
@purpose Verify frame-sampling comparison expressions and coverage metrics.
"""

import csv
import importlib.util
import sys
from pathlib import Path

import cv2
import numpy as np


SCRIPT = Path(__file__).parents[2] / "scripts" / "diagnostics" / "compare-frame-sampling.py"
SPEC = importlib.util.spec_from_file_location("compare_frame_sampling", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
sampling = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sampling
SPEC.loader.exec_module(sampling)


def _write_frame(path: Path, value: int) -> None:
    """Write a small deterministic grayscale fixture."""
    image = np.full((16, 16), value, dtype=np.uint8)
    assert cv2.imwrite(str(path), image)


def test_baseline_filters_are_independent_comparison_strategies() -> None:
    """Keep the diagnostic baselines distinct from production candidate merging."""
    filters = sampling.sampling_filters(scene_threshold=0.3, interval_sec=5.0)

    assert filters == {
        "scene": "eq(n,0)+gt(scene,0.3)",
        "fixed": "eq(n,0)+gte(t-prev_selected_t,5.0)",
    }


def test_metrics_include_video_boundaries_and_transcript_distance(tmp_path: Path) -> None:
    """Count unsampled head/tail time and report speech midpoint proximity."""
    first = tmp_path / "first.jpg"
    duplicate = tmp_path / "duplicate.jpg"
    distinct = tmp_path / "distinct.jpg"
    _write_frame(first, 0)
    _write_frame(duplicate, 0)
    gradient = np.tile(np.arange(16, dtype=np.uint8), (16, 1)) * 16
    assert cv2.imwrite(str(distinct), gradient)

    metrics = sampling.calculate_metrics(
        [(first, 0.0), (duplicate, 5.0), (distinct, 9.0)],
        duration_sec=12.0,
        speech_midpoints=[1.0, 11.0],
    )

    assert metrics.frame_count == 3
    assert metrics.max_gap_sec == 5.0
    assert metrics.mean_gap_sec == 3.0
    assert metrics.adjacent_perceptual_duplicates == 1
    assert metrics.unique_file_hashes == 2
    assert metrics.transcript_mean_distance_sec == 1.5
    assert metrics.transcript_max_distance_sec == 2.0


def test_manifest_preserves_nested_hybrid_frame_path(tmp_path: Path) -> None:
    """Keep candidate subdirectories so downstream diagnostics can reopen frames."""
    frame = tmp_path / "hybrid" / "frames" / "scene" / "frame.jpg"
    frame.parent.mkdir(parents=True)
    frame.touch()
    manifest = tmp_path / "hybrid" / "manifest.csv"

    sampling.write_manifest(manifest, [(frame, 1.0)])

    with manifest.open(newline="", encoding="utf-8") as handle:
        row = next(csv.DictReader(handle))
    assert row["filename"] == "scene/frame.jpg"
