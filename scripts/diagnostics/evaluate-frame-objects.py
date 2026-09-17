#!/usr/bin/env python3
"""@type script
@purpose Benchmark a compact NanoDet ONNX model on retained sampling frames.
@dependencies opencv-python-headless, numpy
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import platform
import time
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np


COCO_CLASSES = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)


@dataclass(frozen=True)
class ObjectObservation:
    """One COCO object prediction in original-frame pixel coordinates."""

    label: str
    confidence: float
    region: tuple[int, int, int, int]


@dataclass(frozen=True)
class ObjectLabel:
    """One exhaustive object label in source-frame pixel coordinates."""

    label: str
    region: tuple[int, int, int, int]


@dataclass(frozen=True)
class LetterboxTransform:
    """Geometry needed to map the square model input back to its source frame."""

    top: int
    left: int
    resized_height: int
    resized_width: int
    source_height: int
    source_width: int


def file_sha256(path: Path) -> str:
    """Hash a model incrementally so its exact benchmark identity is auditable."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def letterbox(
    image: np.ndarray, size: int = 416
) -> tuple[np.ndarray, LetterboxTransform]:
    """Resize without distortion and center the image on a black square canvas."""
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("source image must have positive dimensions")
    scale = min(size / width, size / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = cv2.resize(
        image, (resized_width, resized_height), interpolation=cv2.INTER_AREA
    )
    top = (size - resized_height) // 2
    left = (size - resized_width) // 2
    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    canvas[top : top + resized_height, left : left + resized_width] = resized
    return canvas, LetterboxTransform(
        top, left, resized_height, resized_width, height, width
    )


def map_box_to_source(
    box: Sequence[float], transform: LetterboxTransform
) -> tuple[int, int, int, int]:
    """Convert model-space x1/y1/x2/y2 into clipped source-space x/y/w/h."""
    x1, y1, x2, y2 = box
    x_scale = transform.source_width / transform.resized_width
    y_scale = transform.source_height / transform.resized_height
    source_x1 = round((x1 - transform.left) * x_scale)
    source_y1 = round((y1 - transform.top) * y_scale)
    source_x2 = round((x2 - transform.left) * x_scale)
    source_y2 = round((y2 - transform.top) * y_scale)
    source_x1 = min(max(source_x1, 0), transform.source_width)
    source_y1 = min(max(source_y1, 0), transform.source_height)
    source_x2 = min(max(source_x2, source_x1), transform.source_width)
    source_y2 = min(max(source_y2, source_y1), transform.source_height)
    return source_x1, source_y1, source_x2 - source_x1, source_y2 - source_y1


def intersection_over_union(left: Sequence[int], right: Sequence[int]) -> float:
    """Return intersection-over-union for source-space x/y/width/height boxes."""
    left_x, left_y, left_width, left_height = left
    right_x, right_y, right_width, right_height = right
    intersection_width = max(
        0, min(left_x + left_width, right_x + right_width) - max(left_x, right_x)
    )
    intersection_height = max(
        0, min(left_y + left_height, right_y + right_height) - max(left_y, right_y)
    )
    intersection = intersection_width * intersection_height
    union = left_width * left_height + right_width * right_height - intersection
    return intersection / union if union > 0 else 0.0


def score_observations(
    expected: Sequence[ObjectLabel],
    observed: Sequence[ObjectObservation],
    minimum_iou: float,
) -> tuple[int, int, int]:
    """Greedily match same-class boxes by IoU and return TP, FP, and FN counts."""
    candidates = sorted(
        (
            (
                intersection_over_union(label.region, item.region),
                label_index,
                item_index,
            )
            for label_index, label in enumerate(expected)
            for item_index, item in enumerate(observed)
            if label.label == item.label
        ),
        reverse=True,
    )
    matched_labels: set[int] = set()
    matched_observations: set[int] = set()
    for overlap, label_index, item_index in candidates:
        if overlap < minimum_iou:
            break
        if label_index not in matched_labels and item_index not in matched_observations:
            matched_labels.add(label_index)
            matched_observations.add(item_index)
    true_positives = len(matched_labels)
    return (
        true_positives,
        len(observed) - true_positives,
        len(expected) - true_positives,
    )


def load_ground_truth(
    ground_truth_path: Path | None, sampling_directory: Path
) -> tuple[dict[float, list[ObjectLabel]], str | None, str | None]:
    """Load exhaustive labels and enforce their declared source-video checksum."""
    if ground_truth_path is None:
        return {}, None, None
    payload = json.loads(ground_truth_path.read_text(encoding="utf-8"))
    expected_checksum = payload.get("source_sha256")
    sampling_report_path = sampling_directory / "report.json"
    if not expected_checksum or not sampling_report_path.is_file():
        raise RuntimeError(
            "object ground truth requires a source_sha256 and sampling report.json"
        )
    sampling_report = json.loads(sampling_report_path.read_text(encoding="utf-8"))
    if sampling_report.get("source_sha256") != expected_checksum:
        raise RuntimeError(
            "ground-truth source checksum does not match the sampling report"
        )
    labels = {
        float(frame["timestamp_sec"]): [
            ObjectLabel(str(item["label"]), tuple(item["region"]))
            for item in frame["objects"]
        ]
        for frame in payload["frames"]
    }
    return labels, str(ground_truth_path), payload.get("annotation_scope")


def labels_at_timestamp(
    labels: dict[float, list[ObjectLabel]], timestamp: float, tolerance: float = 0.001
) -> list[ObjectLabel] | None:
    """Find an exhaustively labeled frame despite manifest decimal serialization."""
    return next(
        (
            items
            for labeled_at, items in labels.items()
            if abs(labeled_at - timestamp) <= tolerance
        ),
        None,
    )


class NanoDet:
    """Minimal OpenCV-DNN runner for OpenCV Zoo's NanoDet-Plus ONNX export."""

    input_size = 416
    strides = (8, 16, 32, 64)
    regression_max = 7

    def __init__(self, model_path: Path, confidence: float, nms_threshold: float):
        self.confidence = confidence
        self.nms_threshold = nms_threshold
        self.net = cv2.dnn.readNet(str(model_path))
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.projection = np.arange(self.regression_max + 1)
        self.anchors = self._generate_anchors()

    def _generate_anchors(self) -> list[np.ndarray]:
        anchors = []
        for stride in self.strides:
            size = self.input_size // stride
            x_values, y_values = np.meshgrid(
                np.arange(size) * stride, np.arange(size) * stride
            )
            anchors.append(
                np.column_stack(
                    (
                        x_values.flatten() + 0.5 * (stride - 1),
                        y_values.flatten() + 0.5 * (stride - 1),
                    )
                )
            )
        return anchors

    def __call__(self, image: np.ndarray) -> tuple[list[ObjectObservation], float]:
        prepared, transform = letterbox(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        normalized = (
            prepared.astype(np.float32)
            - np.array([103.53, 116.28, 123.675], dtype=np.float32)
        ) / np.array([57.375, 57.12, 58.395], dtype=np.float32)
        self.net.setInput(cv2.dnn.blobFromImage(normalized))
        started = time.perf_counter()
        outputs = self.net.forward(self.net.getUnconnectedOutLayersNames())
        elapsed_ms = (time.perf_counter() - started) * 1000
        return self._postprocess(outputs, transform), elapsed_ms

    def _postprocess(
        self, outputs: Sequence[np.ndarray], transform: LetterboxTransform
    ) -> list[ObjectObservation]:
        boxes: list[np.ndarray] = []
        scores: list[np.ndarray] = []
        for stride, class_scores, distances, anchors in zip(
            self.strides, outputs[::2], outputs[1::2], self.anchors
        ):
            class_scores = np.squeeze(class_scores, axis=0)
            distances = np.squeeze(distances, axis=0)
            exponentials = np.exp(distances.reshape(-1, self.regression_max + 1))
            probabilities = exponentials / exponentials.sum(axis=1, keepdims=True)
            distances = (probabilities @ self.projection).reshape(-1, 4) * stride
            boxes.append(
                np.column_stack(
                    (
                        anchors[:, 0] - distances[:, 0],
                        anchors[:, 1] - distances[:, 1],
                        anchors[:, 0] + distances[:, 2],
                        anchors[:, 1] + distances[:, 3],
                    )
                )
            )
            scores.append(class_scores)
        all_boxes = np.concatenate(boxes)
        all_scores = np.concatenate(scores)
        class_ids = np.argmax(all_scores, axis=1)
        confidences = np.max(all_scores, axis=1)
        boxes_xywh = all_boxes.copy()
        boxes_xywh[:, 2:4] -= boxes_xywh[:, 0:2]
        kept = cv2.dnn.NMSBoxesBatched(
            boxes_xywh.tolist(),
            confidences.tolist(),
            class_ids.tolist(),
            self.confidence,
            self.nms_threshold,
        )
        observations = []
        for index in np.asarray(kept).reshape(-1):
            class_id = int(class_ids[index])
            observations.append(
                ObjectObservation(
                    COCO_CLASSES[class_id],
                    round(float(confidences[index]), 4),
                    map_box_to_source(all_boxes[index], transform),
                )
            )
        return observations


def evaluate_strategy(
    strategy_directory: Path,
    detector: Callable[[np.ndarray], tuple[list[ObjectObservation], float]],
    labels: dict[float, list[ObjectLabel]] | None = None,
    minimum_iou: float = 0.5,
) -> dict[str, object]:
    """Run a detector over every safely resolved frame in one sampling manifest."""
    with (strategy_directory / "manifest.csv").open(
        newline="", encoding="utf-8"
    ) as handle:
        manifest = list(csv.DictReader(handle))
    frames_root = (strategy_directory / "frames").resolve()
    frames = []
    latencies = []
    label_counts: Counter[str] = Counter()
    true_positives = 0
    false_positives = 0
    false_negatives = 0
    labeled_frame_count = 0
    for row in manifest:
        source = (frames_root / row["filename"]).resolve()
        if not source.is_relative_to(frames_root):
            raise RuntimeError(f"manifest frame escapes frame root: {row['filename']}")
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"could not decode {source}")
        observations, latency_ms = detector(image)
        timestamp = float(row["timestamp_sec"])
        expected = labels_at_timestamp(labels or {}, timestamp)
        frame_score = None
        if expected is not None:
            labeled_frame_count += 1
            matched, unsupported, missed = score_observations(
                expected, observations, minimum_iou
            )
            true_positives += matched
            false_positives += unsupported
            false_negatives += missed
            frame_score = {
                "true_positives": matched,
                "false_positives": unsupported,
                "false_negatives": missed,
            }
        latencies.append(latency_ms)
        label_counts.update(item.label for item in observations)
        frames.append(
            {
                "filename": row["filename"],
                "timestamp_sec": timestamp,
                "inference_ms": round(latency_ms, 3),
                "expected_objects": (
                    [asdict(item) for item in expected]
                    if expected is not None
                    else None
                ),
                "score": frame_score,
                "observations": [asdict(item) for item in observations],
            }
        )
    ordered = sorted(latencies)
    percentile_index = max(0, int(np.ceil(len(ordered) * 0.95)) - 1)
    precision = (
        true_positives / (true_positives + false_positives)
        if true_positives + false_positives
        else None
    )
    recall = (
        true_positives / (true_positives + false_negatives)
        if true_positives + false_negatives
        else None
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    return {
        "frame_count": len(frames),
        "frames_with_objects": sum(bool(frame["observations"]) for frame in frames),
        "observation_count": sum(label_counts.values()),
        "class_counts": dict(sorted(label_counts.items())),
        "mean_inference_ms": round(float(np.mean(latencies)), 3) if latencies else None,
        "p95_inference_ms": round(ordered[percentile_index], 3) if ordered else None,
        "labeled_frame_count": labeled_frame_count,
        "true_positives": true_positives if labels else None,
        "false_positives": false_positives if labels else None,
        "false_negatives": false_negatives if labels else None,
        "object_precision": round(precision, 4) if precision is not None else None,
        "object_recall": round(recall, 4) if recall is not None else None,
        "object_f1": round(f1, 4) if f1 is not None else None,
        "frames": frames,
    }


def main() -> None:
    """Benchmark NanoDet on selected sampling strategies and retain raw evidence."""
    parser = argparse.ArgumentParser(description="Evaluate ONNX object detection")
    parser.add_argument("sampling_directory", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("output_report", type=Path)
    parser.add_argument("--strategy", action="append", default=[])
    parser.add_argument("--ground-truth", type=Path)
    parser.add_argument("--minimum-confidence", type=float, default=0.35)
    parser.add_argument("--nms-threshold", type=float, default=0.6)
    parser.add_argument("--minimum-iou", type=float, default=0.5)
    args = parser.parse_args()
    if not 0 <= args.minimum_confidence <= 1:
        parser.error("minimum confidence must be between 0 and 1")
    if not 0 <= args.nms_threshold <= 1:
        parser.error("NMS threshold must be between 0 and 1")
    if not 0 <= args.minimum_iou <= 1:
        parser.error("minimum IoU must be between 0 and 1")
    if not args.model.is_file():
        parser.error(f"model does not exist: {args.model}")
    requested = set(args.strategy)
    directories = [
        path
        for path in sorted(args.sampling_directory.iterdir())
        if (path / "manifest.csv").is_file()
        and (not requested or path.name in requested)
    ]
    missing = requested - {path.name for path in directories}
    if missing:
        parser.error(f"sampling strategies not found: {', '.join(sorted(missing))}")
    if not directories:
        parser.error("sampling directory contains no matching strategy manifests")
    labels, ground_truth, annotation_scope = load_ground_truth(
        args.ground_truth, args.sampling_directory
    )
    detector = NanoDet(args.model, args.minimum_confidence, args.nms_threshold)
    report = {
        "engine": "opencv_dnn_nanodet_plus_1.5x_416",
        "runtime": {"opencv": cv2.__version__, "python": platform.python_version()},
        "model": {
            "path": str(args.model),
            "sha256": file_sha256(args.model),
            "size_bytes": args.model.stat().st_size,
        },
        "minimum_confidence": args.minimum_confidence,
        "nms_threshold": args.nms_threshold,
        "minimum_iou": args.minimum_iou,
        "ground_truth": ground_truth,
        "annotation_scope": annotation_scope,
        "strategies": {
            path.name: evaluate_strategy(path, detector, labels, args.minimum_iou)
            for path in directories
        },
    }
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote object evaluation to {args.output_report}")


if __name__ == "__main__":
    main()
