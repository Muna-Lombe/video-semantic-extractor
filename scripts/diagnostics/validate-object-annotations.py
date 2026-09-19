#!/usr/bin/env python3
"""@type script
@purpose Validate multi-video object annotations against sampling evidence and policy gates.
@dependencies opencv-python-headless
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

import cv2

COCO_CLASSES = frozenset(
    (
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
)
SUBSETS = frozenset(("live", "composited", "screen"))
EXPECTED_SOURCES = frozenset(f"sample_{index}.mp4" for index in range(1, 6))


def _manifest_frames(sampling_directory: Path) -> tuple[str, dict[str, float]]:
    """Return the verified source identity and hybrid manifest frame map."""
    report_path = sampling_directory / "report.json"
    manifest_path = sampling_directory / "hybrid" / "manifest.csv"
    if not report_path.is_file() or not manifest_path.is_file():
        raise ValueError(
            f"missing report.json or hybrid/manifest.csv: {sampling_directory}"
        )
    report = json.loads(report_path.read_text(encoding="utf-8"))
    checksum = report.get("source_sha256")
    if not isinstance(checksum, str) or len(checksum) != 64:
        raise ValueError(f"invalid source_sha256 in {report_path}")
    with manifest_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    frames: dict[str, float] = {}
    for row in rows:
        filename = row.get("filename", "")
        if not filename or filename in frames:
            raise ValueError(f"missing or duplicate manifest filename: {filename!r}")
        frames[filename] = float(row["timestamp_sec"])
    return checksum, frames


def validate_annotations(
    payload: dict[str, Any], sampling_root: Path
) -> dict[str, Any]:
    """Validate annotation structure, evidence identity, coverage, and corpus gates."""
    errors: list[str] = []
    sources = payload.get("sources")
    if payload.get("policy_version") != "2026-09-18":
        errors.append("policy_version must be '2026-09-18'")
    if not isinstance(sources, list) or not sources:
        return {
            "valid": False,
            "adequate": False,
            "errors": errors + ["sources must be a non-empty list"],
        }
    review = payload.get("review")
    review_complete = False
    reviewed_frames: list[str] = []
    if not isinstance(review, dict):
        errors.append("review metadata is required")
    else:
        independent_passes = review.get("independent_passes")
        if type(independent_passes) is not int or not 0 <= independent_passes <= 2:
            errors.append("review.independent_passes must be an integer from 0 to 2")
        if review.get("predictions_reviewed_before_freeze") is not False:
            errors.append("review.predictions_reviewed_before_freeze must be false")
        adjudication_status = review.get("adjudication_status")
        if adjudication_status not in ("not_started", "in_progress", "complete"):
            errors.append(
                "review.adjudication_status must be 'not_started', 'in_progress', or 'complete'"
            )
        elif independent_passes != 2 and adjudication_status != "not_started":
            errors.append(
                "review.adjudication_status must be 'not_started' until two "
                "independent passes are complete"
            )
        if not isinstance(review.get("adjudication_log"), list):
            errors.append("review.adjudication_log must be a list")
        reviewed_frames_value = review.get("reviewed_frames")
        if not isinstance(reviewed_frames_value, list) or any(
            not isinstance(frame_key, str) for frame_key in reviewed_frames_value
        ):
            errors.append("review.reviewed_frames must be a list of frame keys")
        else:
            reviewed_frames = reviewed_frames_value

    seen_sources: set[str] = set()
    seen_ids: set[str] = set()
    class_counts: Counter[str] = Counter()
    subset_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    area_counts: Counter[str] = Counter()
    frame_count = 0
    expected_reviewed_frames: set[str] = set()

    for source in sources:
        source_name = source.get("source")
        if (
            not isinstance(source_name, str)
            or not source_name
            or Path(source_name).name != source_name
        ):
            errors.append(f"invalid source name: {source_name!r}")
            continue
        if source_name in seen_sources:
            errors.append(f"duplicate source: {source_name}")
            continue
        seen_sources.add(source_name)
        sampling_directory = sampling_root / Path(source_name).stem
        try:
            checksum, manifest = _manifest_frames(sampling_directory)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            errors.append(str(exc))
            continue
        if source.get("source_sha256") != checksum:
            errors.append(
                f"{source_name}: source_sha256 does not match sampling report"
            )

        annotated_frames = source.get("frames")
        if not isinstance(annotated_frames, list):
            errors.append(f"{source_name}: frames must be a list")
            continue
        by_filename: dict[str, dict[str, Any]] = {}
        for frame in annotated_frames:
            filename = frame.get("filename")
            if not isinstance(filename, str) or filename in by_filename:
                errors.append(
                    f"{source_name}: missing or duplicate frame filename {filename!r}"
                )
                continue
            by_filename[filename] = frame
        missing = sorted(set(manifest) - set(by_filename))
        extra = sorted(set(by_filename) - set(manifest))
        if missing:
            errors.append(
                f"{source_name}: missing annotated frames: {', '.join(missing)}"
            )
        if extra:
            errors.append(
                f"{source_name}: frames absent from manifest: {', '.join(extra)}"
            )

        frames_root = (sampling_directory / "hybrid" / "frames").resolve()
        for filename in sorted(set(manifest) & set(by_filename)):
            frame_count += 1
            expected_reviewed_frames.add(f"{source_name}/{filename}")
            frame = by_filename[filename]
            try:
                timestamp = float(frame.get("timestamp_sec"))
            except (TypeError, ValueError):
                errors.append(f"{source_name}/{filename}: invalid timestamp_sec")
                continue
            if abs(timestamp - manifest[filename]) > 0.001:
                errors.append(
                    f"{source_name}/{filename}: timestamp does not match manifest"
                )
            image_path = (frames_root / filename).resolve()
            if not image_path.is_relative_to(frames_root):
                errors.append(f"{source_name}/{filename}: frame escapes frame root")
                continue
            image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
            if image is None:
                errors.append(f"{source_name}/{filename}: frame cannot be decoded")
                continue
            height, width = image.shape[:2]
            objects = frame.get("objects")
            if not isinstance(objects, list):
                errors.append(f"{source_name}/{filename}: objects must be a list")
                continue
            if not isinstance(frame.get("out_of_taxonomy"), list):
                errors.append(
                    f"{source_name}/{filename}: out_of_taxonomy must be a list"
                )
            for item in objects:
                annotation_id = item.get("id")
                label = item.get("label")
                subset = item.get("subset")
                region = item.get("region")
                prefix = f"{source_name}/{filename}/{annotation_id}"
                if not isinstance(annotation_id, str) or not annotation_id:
                    errors.append(
                        f"{source_name}/{filename}: annotation id is required"
                    )
                elif annotation_id in seen_ids:
                    errors.append(f"{prefix}: duplicate annotation id")
                else:
                    seen_ids.add(annotation_id)
                if label not in COCO_CLASSES:
                    errors.append(f"{prefix}: unsupported COCO label {label!r}")
                if subset not in SUBSETS:
                    errors.append(f"{prefix}: invalid subset {subset!r}")
                if (
                    not isinstance(region, list)
                    or len(region) != 4
                    or any(type(value) is not int for value in region)
                ):
                    errors.append(f"{prefix}: region must contain four integers")
                    continue
                x, y, box_width, box_height = region
                if x < 0 or y < 0 or box_width < 8 or box_height < 8:
                    errors.append(
                        f"{prefix}: region violates origin or minimum-size policy"
                    )
                    continue
                if x + box_width > width or y + box_height > height:
                    errors.append(f"{prefix}: region exceeds {width}x{height} frame")
                    continue
                if label in COCO_CLASSES and subset in SUBSETS:
                    class_counts[label] += 1
                    subset_counts[subset] += 1
                    source_counts[source_name] += 1
                    area_ratio = box_width * box_height / (width * height)
                    area_counts[
                        (
                            "small"
                            if area_ratio < 0.02
                            else "large" if area_ratio > 0.20 else "medium"
                        )
                    ] += 1

    positive_count = sum(class_counts.values())
    non_person_count = positive_count - class_counts["person"]
    review_complete = (
        isinstance(review, dict)
        and review.get("independent_passes") == 2
        and review.get("adjudication_status") == "complete"
        and set(reviewed_frames) == expected_reviewed_frames
    )
    gates = {
        "review_complete": review_complete,
        "five_sources": seen_sources == EXPECTED_SOURCES,
        "fifty_non_person_instances": non_person_count >= 50,
        "five_non_person_classes": len(set(class_counts) - {"person"}) >= 5,
        "subset_minimums": subset_counts["live"] >= 20
        and subset_counts["screen"] >= 20
        and subset_counts["composited"] >= 10,
        "scale_minimums": area_counts["small"] >= 15 and area_counts["large"] >= 15,
        "source_concentration": positive_count > 0
        and max(source_counts.values(), default=0) / positive_count <= 0.60,
    }
    return {
        "valid": not errors,
        "adequate": not errors and all(gates.values()),
        "errors": errors,
        "counts": {
            "sources": len(seen_sources),
            "frames": frame_count,
            "objects": positive_count,
            "non_person_objects": non_person_count,
            "classes": dict(sorted(class_counts.items())),
            "subsets": dict(sorted(subset_counts.items())),
            "area_bands": dict(sorted(area_counts.items())),
            "sources_with_objects": dict(sorted(source_counts.items())),
        },
        "corpus_adequacy_gates": gates,
    }


def main() -> None:
    """Validate a fixture and emit a machine-readable audit report."""
    parser = argparse.ArgumentParser(
        description="Validate multi-video object annotations"
    )
    parser.add_argument("annotations", type=Path)
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("output_report", type=Path)
    parser.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="succeed when structurally valid annotations have not met corpus gates",
    )
    args = parser.parse_args()
    payload = json.loads(args.annotations.read_text(encoding="utf-8"))
    report = validate_annotations(payload, args.sampling_root)
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote object annotation validation to {args.output_report}")
    if not report["valid"] or (not args.allow_incomplete and not report["adequate"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
