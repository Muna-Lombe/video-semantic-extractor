#!/usr/bin/env python3
"""@type script
@purpose Evaluate Tesseract OCR on retained sampling frames with auditable regions.
@dependencies tesseract, opencv-python-headless
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np


TEXT_CATEGORIES = frozenset(("caption", "ui"))


@dataclass(frozen=True)
class TextObservation:
    """One OCR word and its confidence and pixel-space bounding box."""

    text: str
    confidence: float
    region: tuple[int, int, int, int]


class PPOCRTextRegionDetector:
    """Propose multiple source-coordinate text boxes with OpenCV's PP-OCRv3 DB model."""

    def __init__(
        self,
        model_path: Path,
        input_size: int = 736,
        binary_threshold: float = 0.3,
        polygon_threshold: float = 0.5,
        unclip_ratio: float = 2.0,
        max_candidates: int = 200,
    ) -> None:
        if input_size <= 0 or input_size % 32:
            raise ValueError("text detector input size must be a positive multiple of 32")
        self.model_path = model_path
        self.input_size = input_size
        self.model = cv2.dnn_TextDetectionModel_DB(cv2.dnn.readNet(str(model_path)))
        self.model.setBinaryThreshold(binary_threshold)
        self.model.setPolygonThreshold(polygon_threshold)
        self.model.setUnclipRatio(unclip_ratio)
        self.model.setMaxCandidates(max_candidates)
        self.model.setInputSize((input_size, input_size))
        self.model.setInputMean((123.675, 116.28, 103.53))
        self.model.setInputScale(1.0 / 255.0 / np.array([0.229, 0.224, 0.225]))

    def __call__(self, image: np.ndarray) -> list[tuple[int, int, int, int]]:
        """Detect text polygons and return clipped axis-aligned source-image boxes."""
        height, width = image.shape[:2]
        resized = cv2.resize(image, (self.input_size, self.input_size))
        polygons, _confidences = self.model.detect(resized)
        boxes: list[tuple[int, int, int, int]] = []
        scale_x = width / self.input_size
        scale_y = height / self.input_size
        for polygon in polygons:
            points = np.asarray(polygon).reshape(-1, 2)
            left = max(0, int(np.floor(points[:, 0].min() * scale_x)))
            top = max(0, int(np.floor(points[:, 1].min() * scale_y)))
            right = min(width, int(np.ceil(points[:, 0].max() * scale_x)))
            bottom = min(height, int(np.ceil(points[:, 1].max() * scale_y)))
            if right > left and bottom > top:
                boxes.append((left, top, right - left, bottom - top))
        return sorted(set(boxes), key=lambda box: (box[1], box[0], box[2], box[3]))


def run_tesseract(image_path: Path, page_segmentation_mode: int) -> str:
    """Run the compact system OCR engine and return its TSV observations."""
    try:
        result = subprocess.run(
            [
                "tesseract",
                str(image_path),
                "stdout",
                "--psm",
                str(page_segmentation_mode),
                "tsv",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise RuntimeError(detail.strip()) from exc
    return result.stdout


def sha256_file(path: Path) -> str:
    """Return a stable identity for an externally supplied model artifact."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def expected_category_text(
    labels: Sequence[dict[str, object]], timestamp_sec: float, category: str
) -> str:
    """Return active exhaustive words for one declared text category."""
    return " ".join(
        str(label["text"])
        for label in labels
        if label.get("category") == category
        and float(label["start_sec"]) <= timestamp_sec < float(label["end_sec"])
    )


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
    read_mode = cv2.IMREAD_COLOR if mode == "upscale" else cv2.IMREAD_GRAYSCALE
    image = cv2.imread(str(image_path), read_mode)
    if image is None:
        raise RuntimeError(f"could not decode {image_path}")
    image = cv2.resize(image, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    if mode == "threshold":
        image = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    if not cv2.imwrite(str(output_path), image):
        raise RuntimeError(f"could not write {output_path}")
    return output_path


def propose_text_region(
    image_path: Path, output_path: Path, proposal: str
) -> tuple[Path, tuple[int, int]]:
    """Create a targeted OCR region and return its source-coordinate offset."""
    if proposal == "full-frame":
        return image_path, (0, 0)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"could not decode {image_path}")
    if proposal == "caption-band":
        top = round(image.shape[0] * 0.55)
        region = image[top:, :]
        offset = (0, top)
    else:
        raise ValueError(f"unsupported text-region proposal: {proposal}")
    if not cv2.imwrite(str(output_path), region):
        raise RuntimeError(f"could not write {output_path}")
    return output_path, offset


def propose_text_regions(
    image_path: Path,
    output_directory: Path,
    proposal: str,
    detector: Callable[[np.ndarray], Sequence[tuple[int, int, int, int]]] | None,
) -> list[tuple[Path, tuple[int, int]]]:
    """Return one fixed region or multiple detector-proposed OCR crops."""
    if proposal != "detector":
        path, offset = propose_text_region(
            image_path, output_directory / "fixed-region.png", proposal
        )
        return [(path, offset)]
    if detector is None:
        raise ValueError("the detector text-region proposal requires a detector model")
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"could not decode {image_path}")
    proposals: list[tuple[Path, tuple[int, int]]] = []
    for index, (x, y, width, height) in enumerate(detector(image)):
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise RuntimeError("text detector returned an invalid region")
        if x + width > image.shape[1] or y + height > image.shape[0]:
            raise RuntimeError("text detector returned a region outside the source image")
        output_path = output_directory / f"detected-region-{index:04d}.png"
        if not cv2.imwrite(str(output_path), image[y : y + height, x : x + width]):
            raise RuntimeError(f"could not write {output_path}")
        proposals.append((output_path, (x, y)))
    return proposals


def map_observations_to_source(
    observations: Sequence[TextObservation],
    offset: tuple[int, int],
    preprocessing_mode: str,
) -> list[TextObservation]:
    """Map OCR boxes from a prepared region back to original-frame pixels."""
    scale = 1 if preprocessing_mode == "original" else 2
    offset_x, offset_y = offset
    return [
        TextObservation(
            item.text,
            item.confidence,
            (
                round(item.region[0] / scale) + offset_x,
                round(item.region[1] / scale) + offset_y,
                round(item.region[2] / scale),
                round(item.region[3] / scale),
            ),
        )
        for item in observations
    ]


def load_ground_truth(
    ground_truth_path: Path | None, sampling_directory: Path
) -> tuple[list[dict[str, object]], str | None]:
    """Load labels and reject checksum-bound truth for a different source video."""
    if ground_truth_path is None:
        return [], None
    payload = json.loads(ground_truth_path.read_text(encoding="utf-8"))
    expected_checksum = payload.get("source_sha256")
    if expected_checksum:
        sampling_report_path = sampling_directory / "report.json"
        if not sampling_report_path.is_file():
            raise RuntimeError(
                "checksum-bound ground truth requires the sampling report.json"
            )
        sampling_report = json.loads(sampling_report_path.read_text(encoding="utf-8"))
        actual_checksum = sampling_report.get("source_sha256")
        if actual_checksum != expected_checksum:
            raise RuntimeError(
                "ground-truth source checksum does not match the sampling report"
            )
    labels = payload["labels"]
    invalid_categories = sorted(
        {
            str(label.get("category"))
            for label in labels
            if label.get("category") not in TEXT_CATEGORIES
        }
    )
    if invalid_categories:
        raise RuntimeError(
            "ground-truth labels require category 'caption' or 'ui': "
            + ", ".join(invalid_categories)
        )
    return labels, str(ground_truth_path)


def evaluate_strategy(
    strategy_dir: Path,
    labels: Sequence[dict[str, object]],
    minimum_confidence: float,
    mode: str,
    page_segmentation_mode: int = 11,
    text_region: str = "full-frame",
    ocr_runner: Callable[[Path, int], str] = run_tesseract,
    region_detector: Callable[
        [np.ndarray], Sequence[tuple[int, int, int, int]]
    ]
    | None = None,
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
    proposal_count = 0
    category_recalls: dict[str, list[float]] = {
        category: [] for category in sorted(TEXT_CATEGORIES)
    }
    category_detected_labels: dict[str, set[int]] = {
        category: set() for category in sorted(TEXT_CATEGORIES)
    }
    with tempfile.TemporaryDirectory(prefix="ocr-preprocessed-") as temporary:
        temporary_dir = Path(temporary)
        frames_root = (strategy_dir / "frames").resolve()
        for index, row in enumerate(manifest):
            source = (frames_root / row["filename"]).resolve()
            if not source.is_relative_to(frames_root):
                raise RuntimeError(f"manifest frame escapes frame root: {row['filename']}")
            frame_directory = temporary_dir / f"{index:06d}"
            frame_directory.mkdir()
            proposals = propose_text_regions(
                source,
                frame_directory,
                text_region,
                region_detector,
            )
            proposal_count += len(proposals)
            observations: list[TextObservation] = []
            for proposal_index, (proposed, offset) in enumerate(proposals):
                prepared = preprocess(
                    proposed,
                    frame_directory / f"preprocessed-{proposal_index:04d}.png",
                    mode,
                )
                proposed_observations = parse_tesseract_tsv(
                    ocr_runner(prepared, page_segmentation_mode), minimum_confidence
                )
                observations.extend(
                    map_observations_to_source(proposed_observations, offset, mode)
                )
            observed = " ".join(item.text for item in observations)
            timestamp = float(row["timestamp_sec"])
            expected = expected_text(labels, timestamp)
            recall = word_recall(expected, observed)
            precision = word_precision(expected, observed)
            f1_score = harmonic_mean(precision, recall)
            category_scores: dict[str, float | None] = {}
            for category in sorted(TEXT_CATEGORIES):
                category_expected = expected_category_text(labels, timestamp, category)
                category_recall = word_recall(category_expected, observed)
                category_scores[category] = category_recall
                if category_recall is not None:
                    category_recalls[category].append(category_recall)
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
                    category = label.get("category")
                    if category in TEXT_CATEGORIES:
                        category_detected_labels[str(category)].add(label_index)
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
                    "category_word_recall": category_scores,
                    "text_region_proposals": len(proposals),
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
        "text_region_proposals": proposal_count,
        "categories": {
            category: {
                "labeled_frame_count": len(category_recalls[category]),
                "mean_word_recall": (
                    round(
                        sum(category_recalls[category])
                        / len(category_recalls[category]),
                        4,
                    )
                    if category_recalls[category]
                    else None
                ),
                "ground_truth_labels": sum(
                    label.get("category") == category for label in labels
                ),
                "ground_truth_labels_detected": len(
                    category_detected_labels[category]
                ),
                "ground_truth_label_recall": (
                    round(
                        len(category_detected_labels[category])
                        / sum(label.get("category") == category for label in labels),
                        4,
                    )
                    if any(label.get("category") == category for label in labels)
                    else None
                ),
            }
            for category in sorted(TEXT_CATEGORIES)
        },
        "adjacent_ocr_changes": changes,
        "frames": frames,
    }


def main() -> None:
    """Evaluate all available sampling strategies and write a JSON evidence report."""
    parser = argparse.ArgumentParser(description="Evaluate OCR on frame-sampling artifacts")
    parser.add_argument("sampling_directory", type=Path)
    parser.add_argument("output_report", type=Path)
    parser.add_argument(
        "--strategy",
        action="append",
        default=[],
        help="sampling strategy to evaluate; repeat as needed (default: all)",
    )
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--minimum-confidence", type=float, default=0.5)
    parser.add_argument(
        "--preprocess",
        choices=("original", "upscale", "grayscale", "threshold"),
        default="original",
    )
    parser.add_argument(
        "--page-segmentation-mode",
        type=int,
        default=11,
        help="Tesseract page segmentation mode (default: sparse text mode 11)",
    )
    parser.add_argument(
        "--text-region",
        choices=("full-frame", "caption-band", "detector"),
        default="full-frame",
        help="OCR the full image, lower caption band, or PP-OCRv3 text proposals",
    )
    parser.add_argument(
        "--text-detector-model",
        type=Path,
        help="OpenCV Zoo PP-OCRv3 DB ONNX model (required for --text-region detector)",
    )
    args = parser.parse_args()
    if not 0 <= args.minimum_confidence <= 1:
        parser.error("minimum confidence must be between 0 and 1")
    if not 0 <= args.page_segmentation_mode <= 13:
        parser.error("page segmentation mode must be between 0 and 13")
    if args.text_region == "detector" and args.text_detector_model is None:
        parser.error("--text-detector-model is required for --text-region detector")
    if args.text_region != "detector" and args.text_detector_model is not None:
        parser.error("--text-detector-model requires --text-region detector")
    region_detector = (
        PPOCRTextRegionDetector(args.text_detector_model)
        if args.text_detector_model is not None
        else None
    )
    labels, ground_truth = load_ground_truth(args.ground_truth, args.sampling_directory)
    requested_strategies = set(args.strategy)
    strategies = {
        path.name: evaluate_strategy(
            path,
            labels,
            args.minimum_confidence,
            args.preprocess,
            args.page_segmentation_mode,
            args.text_region,
            region_detector=region_detector,
        )
        for path in sorted(args.sampling_directory.iterdir())
        if (path / "manifest.csv").is_file()
        and (not requested_strategies or path.name in requested_strategies)
    }
    if not strategies:
        parser.error("sampling directory contains no requested strategy manifests")
    report = {
        "engine": "tesseract_cli",
        "minimum_confidence": args.minimum_confidence,
        "preprocess": args.preprocess,
        "page_segmentation_mode": args.page_segmentation_mode,
        "text_region": args.text_region,
        "text_detector": (
            {
                "family": "PP-OCRv3 DB English",
                "model_path": str(args.text_detector_model),
                "model_sha256": sha256_file(args.text_detector_model),
                "model_size_bytes": args.text_detector_model.stat().st_size,
                "input_size": [736, 736],
            }
            if args.text_detector_model is not None
            else None
        ),
        "ground_truth": ground_truth,
        "strategies": strategies,
    }
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote OCR evaluation to {args.output_report}")


if __name__ == "__main__":
    main()
