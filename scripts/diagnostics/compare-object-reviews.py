#!/usr/bin/env python3
"""Compare two independent prediction-blind object annotation passes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _iou(left: list[int], right: list[int]) -> float:
    left_x2 = left[0] + left[2]
    left_y2 = left[1] + left[3]
    right_x2 = right[0] + right[2]
    right_y2 = right[1] + right[3]
    intersection_width = max(0, min(left_x2, right_x2) - max(left[0], right[0]))
    intersection_height = max(0, min(left_y2, right_y2) - max(left[1], right[1]))
    intersection = intersection_width * intersection_height
    union = left[2] * left[3] + right[2] * right[3] - intersection
    return intersection / union if union else 0.0


def _matching(
    left_objects: list[dict[str, Any]], right_objects: list[dict[str, Any]]
) -> list[tuple[int, int]]:
    """Return maximum-cardinality matches at the policy's class/subset/IoU rule."""
    edges = [
        [
            right_index
            for right_index, right in enumerate(right_objects)
            if left.get("label") == right.get("label")
            and left.get("subset") == right.get("subset")
            and _iou(left.get("region", []), right.get("region", [])) >= 0.8
        ]
        for left in left_objects
    ]
    matched_left: dict[int, int] = {}

    def visit(left_index: int, visited: set[int]) -> bool:
        for right_index in edges[left_index]:
            if right_index in visited:
                continue
            visited.add(right_index)
            previous = next(
                (
                    candidate_left
                    for candidate_left, candidate_right in matched_left.items()
                    if candidate_right == right_index
                ),
                None,
            )
            if previous is None or visit(previous, visited):
                matched_left[left_index] = right_index
                return True
        return False

    for left_index in range(len(left_objects)):
        visit(left_index, set())
    return sorted(matched_left.items())


def _frame_map(payload: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    frames: dict[tuple[str, str], dict[str, Any]] = {}
    for source in payload.get("sources", []):
        source_name = source.get("source")
        for frame in source.get("frames", []):
            frames[(source_name, frame.get("filename"))] = frame
    return frames


def compare_reviews(
    left_payload: dict[str, Any], right_payload: dict[str, Any]
) -> dict[str, Any]:
    """Report disagreements without using predictions or changing either review."""
    disagreements: list[dict[str, Any]] = []
    if left_payload.get("policy_version") != right_payload.get("policy_version"):
        disagreements.append({"type": "policy_version"})

    left_frames = _frame_map(left_payload)
    right_frames = _frame_map(right_payload)
    for frame_key in sorted(set(left_frames) | set(right_frames)):
        left = left_frames.get(frame_key)
        right = right_frames.get(frame_key)
        source_name, filename = frame_key
        location = {"source": source_name, "filename": filename}
        if left is None or right is None:
            disagreements.append({**location, "type": "frame_coverage"})
            continue

        left_objects = left.get("objects", [])
        right_objects = right.get("objects", [])
        matches = _matching(left_objects, right_objects)
        matched_left = {left_index for left_index, _ in matches}
        matched_right = {right_index for _, right_index in matches}
        for left_index, object_value in enumerate(left_objects):
            if left_index not in matched_left:
                disagreements.append({**location, "type": "left_unmatched", "object": object_value})
        for right_index, object_value in enumerate(right_objects):
            if right_index not in matched_right:
                disagreements.append({**location, "type": "right_unmatched", "object": object_value})

        if left.get("out_of_taxonomy", []) != right.get("out_of_taxonomy", []):
            disagreements.append({**location, "type": "out_of_taxonomy"})

    return {
        "agree": not disagreements,
        "frames_compared": len(set(left_frames) & set(right_frames)),
        "disagreements": disagreements,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare two independent object reviews")
    parser.add_argument("left_review", type=Path)
    parser.add_argument("right_review", type=Path)
    parser.add_argument("output_report", type=Path)
    args = parser.parse_args()
    left_payload = json.loads(args.left_review.read_text(encoding="utf-8"))
    right_payload = json.loads(args.right_review.read_text(encoding="utf-8"))
    report = compare_reviews(left_payload, right_payload)
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote object review comparison to {args.output_report}")
    if not report["agree"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()