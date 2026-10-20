"""@type implementation @purpose Shared NanoDet inference used by diagnostics and governed Product extraction."""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass
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
class LetterboxTransform:
    """Geometry needed to map the square model input back to its source frame."""

    top: int
    left: int
    resized_height: int
    resized_width: int
    source_height: int
    source_width: int


def letterbox(image: np.ndarray, size: int = 416) -> tuple[np.ndarray, LetterboxTransform]:
    """Resize without distortion and center the image on a black square canvas."""
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("source image must have positive dimensions")
    scale = min(size / width, size / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    top = (size - resized_height) // 2
    left = (size - resized_width) // 2
    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    canvas[top : top + resized_height, left : left + resized_width] = resized
    return canvas, LetterboxTransform(top, left, resized_height, resized_width, height, width)


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


class NanoDet:
    """Minimal OpenCV-DNN runner for OpenCV Zoo's NanoDet-Plus ONNX export."""

    input_size = 416
    strides = (8, 16, 32, 64)
    regression_max = 7

    def __init__(self, model_path: Path, confidence: float, nms_threshold: float):
        self.confidence = confidence
        self.nms_threshold = nms_threshold
        self.net = cv2.dnn.readNetFromONNX(str(model_path))
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.projection = np.arange(self.regression_max + 1)
        self.anchors = self._generate_anchors()

    def _generate_anchors(self) -> list[np.ndarray]:
        anchors = []
        for stride in self.strides:
            size = self.input_size // stride
            x_values, y_values = np.meshgrid(np.arange(size) * stride, np.arange(size) * stride)
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
            prepared.astype(np.float32) - np.array([103.53, 116.28, 123.675], dtype=np.float32)
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
