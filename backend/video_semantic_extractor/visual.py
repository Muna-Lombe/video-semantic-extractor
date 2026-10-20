"""@type implementation @purpose Add bounded OCR and checksum-bound model observations to Product capsules."""

from __future__ import annotations

import csv
import hashlib
import io
import math
import subprocess
import tempfile
from pathlib import Path

import cv2

from .object_detector import NanoDet
from .pipeline import ExtractionError, analyze_frame
from .schema import Keyframe, ObjectObservation, TextObservation


class VisualAnalyzer:
    """Observe frame text and optional objects without inferring actions or scene origin."""

    def __init__(self, model: Path | None = None, *, confidence: float = 0.35, nms: float = 0.6):
        self.detector = NanoDet(model, confidence, nms) if model else None
        self.model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest() if model else None
        try:
            self.ocr_version = subprocess.run(
                ["tesseract", "--version"], capture_output=True, text=True, check=True, timeout=10
            ).stdout.splitlines()[0]
        except (OSError, subprocess.SubprocessError, IndexError) as exc:
            raise ExtractionError("OCR requires a working Tesseract executable") from exc

    def __call__(self, path: Path, frame_id: int, timestamp: float) -> Keyframe:
        frame = analyze_frame(path, frame_id, timestamp)
        image = cv2.imread(str(path))
        height, width = image.shape[:2]
        frame.width = width
        frame.height = height
        frame.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        if height * width > 3840 * 2160:
            raise ExtractionError("visual extraction supports frames up to 3840x2160 pixels")
        try:
            with tempfile.TemporaryFile() as output:
                subprocess.run(
                    ["tesseract", str(path), "stdout", "--psm", "11", "tsv"],
                    stdout=output,
                    stderr=subprocess.DEVNULL,
                    check=True,
                    timeout=30,
                )
                output.seek(0)
                raw = output.read(2 * 1024 * 1024 + 1)
        except subprocess.TimeoutExpired:
            raise ExtractionError("OCR exceeded its 30-second frame budget") from None
        except subprocess.CalledProcessError:
            raise ExtractionError("Tesseract failed to analyze a sampled frame") from None
        except OSError as exc:
            raise ExtractionError("OCR requires the Tesseract executable") from exc
        if len(raw) > 2 * 1024 * 1024:
            raise ExtractionError("OCR response exceeds its 2 MiB frame budget")
        observations = []
        try:
            rows = csv.DictReader(
                io.StringIO(raw.decode("utf-8")), delimiter="\t", quoting=csv.QUOTE_NONE
            )
            if not {"conf", "left", "top", "width", "height", "text"}.issubset(
                rows.fieldnames or []
            ):
                raise ValueError("missing OCR columns")
            for row in rows:
                text = (row.get("text") or "").strip()
                score = float(row["conf"]) / 100
                box = [int(row[key]) for key in ("left", "top", "width", "height")]
                if not text or not math.isfinite(score) or score < 0.5:
                    continue
                if (
                    score > 1
                    or min(box) < 0
                    or box[2] == 0
                    or box[3] == 0
                    or box[0] + box[2] > width
                    or box[1] + box[3] > height
                ):
                    raise ValueError("invalid OCR observation")
                observations.append(TextObservation(text=text, confidence=score, region=box))
                if len(observations) > 1000:
                    raise ExtractionError("OCR exceeds 1,000 words per frame")
        except (KeyError, ValueError, UnicodeError) as exc:
            raise ExtractionError("Tesseract returned malformed observations") from exc
        frame.text_observations = observations
        frame.text_in_frame = [item.text for item in observations]
        frame.analyzer = "tesseract-psm11" + ("+nanodet-plus-1.5x-416" if self.detector else "")
        if self.detector:
            detected, _ = self.detector(image)
            frame.objects = [
                ObjectObservation(
                    label=item.label, confidence=item.confidence, region=list(item.region)
                )
                for item in detected
                if item.region[2] > 0 and item.region[3] > 0
            ]
        return frame
