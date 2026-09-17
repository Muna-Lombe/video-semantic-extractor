#!/usr/bin/env python3
"""@type script
@purpose Evaluate Tesseract OCR on retained sampling frames with auditable regions.
@dependencies tesseract, opencv-python-headless
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2


@dataclass(frozen=True)
class TextObservation:
    """One OCR word and its confidence and pixel-space bounding box."""

    text: str
    confidence: float
    region: tuple[int, int, int, int]


def run_tesseract(image_path: Path) -> str:
    """Run the compact system OCR engine and return its TSV observations."""
    try:
        result = subprocess.run(
            ["tesseract", str(image_path), "stdout", "--psm", "11", "tsv"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise RuntimeError(detail.strip()) from exc
    return result.stdout


def parse_tesseract_tsv(payload: str, minimum_confidence: float) -> list[TextObservation]:
    """Parse word-level TSV output, discarding blanks and low-confidence guesses."""
    observations: list[TextObservation] = []
    # Tesseract does not escape text as CSV. A recognized literal quote can begin
    # a word, so csv quote handling would merge several physical TSV rows.
    for row in csv.DictReader(payload.splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE):
        text = (row.get("text") or "").strip()
        try:
            confidence = float(row.get("conf", "-1")) / 100
            region = tuple(int(row[field]) for field in ("left", "top", "width", "height"))
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("Tesseract returned malformed TSV output") from exc
        if text and confidence >= minimum_confidence:
            observations.append(TextObservation(text, round(confidence, 4), region))
    return observations


def normalize_words(text: str) -> list[str]:
    """Normalize OCR and labels for case-insensitive word recall measurement."""
    return re.findall(r"[A-Z0-9]+", text.upper())


def expected_text(labels: Sequence[dict[str, object]], timestamp_sec: float) -> str:
    """Return the label active at a sampled timestamp, if one is defined."""
    matches = [
        str(label["text"])
        for label in labels
        if float(label["start_sec"]) <= timestamp_sec < float(label["end_sec"])
    ]
    return " ".join(matches)


def word_recall(expected: str, observed: str) -> float | None:
    """Measure expected-word recall while preserving repeated-word counts."""
    remaining = normalize_words(observed)
    expected_words = normalize_words(expected)
    if not expected_words:
        return None
    matched = 0
    for word in expected_words:
        if word in remaining:
            matched += 1
            remaining.remove(word)
    return round(matched / len(expected_words), 4)


def word_precision(expected: str, observed: str) -> float | None:
    """Measure the share of observed words supported by a labeled frame."""
    expected_words = normalize_words(expected)
    observed_words = normalize_words(observed)
    if not expected_words or not observed_words:
        return None
    matched = 0
    for word in observed_words:
        if word in expected_words:
            matched += 1
            expected_words.remove(word)
    return round(matched / len(observed_words), 4)


def harmonic_mean(precision: float | None, recall: float | None) -> float | None:
    """Return an F1 score when both word metrics are defined."""
    # Precision is undefined when OCR emits no words, but a labeled frame with
    # zero recall is still an unambiguous F1 miss and must remain in macro means.
    if precision is None and recall == 0:
        return 0.0
    if precision is None or recall is None:
        return None
    if precision + recall == 0:
        return 0.0
    return round(2 * precision * recall / (precision + recall), 4)


def preprocess(image_path: Path, output_path: Path, mode: str) -> Path:
    """Create a repeatable OCR input while retaining the original sampled image."""
    if mode == "original":
        return image_path
    image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f"could not decode {image_path}")
    image = cv2.resize(image, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    if mode == "threshold":
        image = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    if not cv2.imwrite(str(output_path), image):
        raise RuntimeError(f"could not write {output_path}")
    return output_path


def evaluate_strategy(
    strategy_dir: Path,
    labels: Sequence[dict[str, object]],
    minimum_confidence: float,
    mode: str,
    ocr_runner: Callable[[Path], str] = run_tesseract,
) -> dict[str, object]:
    """Evaluate every frame named by a sampling diagnostic manifest."""
    with (strategy_dir / "manifest.csv").open(newline="", encoding="utf-8") as handle:
        manifest = list(csv.DictReader(handle))
    frames: list[dict[str, object]] = []
    recalls: list[float] = []
    precisions: list[float] = []
    f1_scores: list[float] = []
    detected_labels: set[int] = set()
    previous_text: str | None = None
    changes = 0
    with tempfile.TemporaryDirectory(prefix="ocr-preprocessed-") as temporary:
        temporary_dir = Path(temporary)
        frames_root = (strategy_dir / "frames").resolve()
        for index, row in enumerate(manifest):
            source = (frames_root / row["filename"]).resolve()
            if not source.is_relative_to(frames_root):
                raise RuntimeError(f"manifest frame escapes frame root: {row['filename']}")
            prepared = preprocess(source, temporary_dir / f"{index:06d}.png", mode)
            observations = parse_tesseract_tsv(ocr_runner(prepared), minimum_confidence)
            observed = " ".join(item.text for item in observations)
            timestamp = float(row["timestamp_sec"])
            expected = expected_text(labels, timestamp)
            recall = word_recall(expected, observed)
            precision = word_precision(expected, observed)
            f1_score = harmonic_mean(precision, recall)
            if recall is not None:
                recalls.append(recall)
            if precision is not None:
                precisions.append(precision)
            if f1_score is not None:
                f1_scores.append(f1_score)
            for label_index, label in enumerate(labels):
                if (
                    float(label["start_sec"]) <= timestamp < float(label["end_sec"])
                    and word_recall(str(label["text"]), observed) == 1.0
                ):
                    detected_labels.add(label_index)
            normalized = " ".join(normalize_words(observed))
            if previous_text is not None and normalized != previous_text:
                changes += 1
            previous_text = normalized
            frames.append(
                {
                    "filename": row["filename"],
                    "timestamp_sec": timestamp,
                    "expected_text": expected or None,
                    "observed_text": observed,
                    "word_precision": precision,
                    "word_recall": recall,
                    "word_f1": f1_score,
                    "observations": [asdict(item) for item in observations],
                }
            )
    return {
        "frame_count": len(frames),
        "labeled_frame_count": len(recalls),
        "mean_word_precision": (
            round(sum(precisions) / len(precisions), 4) if precisions else None
        ),
        "mean_word_recall": round(sum(recalls) / len(recalls), 4) if recalls else None,
        "mean_word_f1": round(sum(f1_scores) / len(f1_scores), 4) if f1_scores else None,
        "ground_truth_labels_detected": len(detected_labels) if labels else None,
        "ground_truth_label_recall": (
            round(len(detected_labels) / len(labels), 4) if labels else None
        ),
        "frames_with_any_text": sum(bool(frame["observed_text"]) for frame in frames),
        "adjacent_ocr_changes": changes,
        "frames": frames,
    }


def main() -> None:
    """Evaluate all available sampling strategies and write a JSON evidence report."""
    parser = argparse.ArgumentParser(description="Evaluate OCR on frame-sampling artifacts")
    parser.add_argument("sampling_directory", type=Path)
    parser.add_argument("output_report", type=Path)
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--minimum-confidence", type=float, default=0.5)
    parser.add_argument(
        "--preprocess", choices=("original", "grayscale", "threshold"), default="original"
    )
    args = parser.parse_args()
    if not 0 <= args.minimum_confidence <= 1:
        parser.error("minimum confidence must be between 0 and 1")
    labels: list[dict[str, object]] = []
    if args.ground_truth:
        labels = json.loads(args.ground_truth.read_text(encoding="utf-8"))["labels"]
    strategies = {
        path.name: evaluate_strategy(path, labels, args.minimum_confidence, args.preprocess)
        for path in sorted(args.sampling_directory.iterdir())
        if (path / "manifest.csv").is_file()
    }
    if not strategies:
        parser.error("sampling directory contains no strategy manifests")
    report = {
        "engine": "tesseract_cli",
        "minimum_confidence": args.minimum_confidence,
        "preprocess": args.preprocess,
        "ground_truth": str(args.ground_truth) if args.ground_truth else None,
        "strategies": strategies,
    }
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote OCR evaluation to {args.output_report}")


if __name__ == "__main__":
    main()
