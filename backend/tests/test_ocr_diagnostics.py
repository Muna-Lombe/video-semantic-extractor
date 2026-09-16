"""@type test
@purpose Verify OCR diagnostic parsing, confidence filtering, and labeled scoring.
"""

import importlib.util
import sys
from pathlib import Path

import cv2
import numpy as np


SCRIPT = Path(__file__).parents[2] / "scripts" / "diagnostics" / "evaluate-frame-ocr.py"
SPEC = importlib.util.spec_from_file_location("evaluate_frame_ocr", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ocr = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ocr
SPEC.loader.exec_module(ocr)

TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"


def test_parse_tesseract_tsv_retains_regions_and_filters_confidence() -> None:
    """Keep usable words with normalized confidence and pixel regions."""
    payload = TSV_HEADER + (
        "5\t1\t1\t1\t1\t1\t10\t20\t30\t40\t92.5\tWELCOME\n"
        "5\t1\t1\t1\t1\t2\t50\t20\t30\t40\t20\tguess\n"
    )
    assert ocr.parse_tesseract_tsv(payload, 0.5) == [
        ocr.TextObservation("WELCOME", 0.925, (10, 20, 30, 40))
    ]


def test_parse_tesseract_tsv_treats_literal_quotes_as_text() -> None:
    """Do not let an OCR quote merge independent physical TSV records."""
    payload = TSV_HEADER + (
        '5\t1\t1\t1\t1\t1\t1\t2\t10\t5\t99\t"coloring\n'
        "5\t1\t1\t1\t1\t2\t12\t2\t10\t5\t98\tpages\n"
    )

    assert ocr.parse_tesseract_tsv(payload, 0.5) == [
        ocr.TextObservation('"coloring', 0.99, (1, 2, 10, 5)),
        ocr.TextObservation("pages", 0.98, (12, 2, 10, 5)),
    ]


def test_word_recall_is_case_and_punctuation_insensitive() -> None:
    """Score labeled words without requiring OCR punctuation or case to match."""
    assert ocr.word_recall("Shop now!", "SHOP, later") == 0.5
    assert ocr.word_recall("", "unexpected") is None


def test_word_precision_penalizes_unsupported_observations() -> None:
    """Count OCR guesses that are absent from exhaustive ground truth."""
    assert ocr.word_precision("Shop now!", "SHOP later") == 0.5
    assert ocr.word_precision("Shop now!", "") is None
    assert ocr.harmonic_mean(0.5, 0.5) == 0.5


def test_evaluate_strategy_scores_manifest_frames(tmp_path: Path) -> None:
    """Join timestamps, labels, retained frames, and OCR output in one report."""
    strategy = tmp_path / "hybrid"
    frames = strategy / "frames"
    frames.mkdir(parents=True)
    assert cv2.imwrite(str(frames / "frame.jpg"), np.zeros((20, 40, 3), dtype=np.uint8))
    (strategy / "manifest.csv").write_text(
        "filename,timestamp_sec,sampling_reasons\nframe.jpg,1.000000,first\n",
        encoding="utf-8",
    )
    payload = TSV_HEADER + "5\t1\t1\t1\t1\t1\t1\t2\t10\t5\t99\tWELCOME\n"
    report = ocr.evaluate_strategy(
        strategy,
        [{"start_sec": 0, "end_sec": 3, "text": "WELCOME"}],
        0.5,
        "original",
        ocr_runner=lambda _path: payload,
    )
    assert report["mean_word_recall"] == 1.0
    assert report["mean_word_precision"] == 1.0
    assert report["mean_word_f1"] == 1.0
    assert report["ground_truth_label_recall"] == 1.0
    assert report["frames_with_any_text"] == 1
    assert report["frames"][0]["observations"][0]["region"] == (1, 2, 10, 5)
