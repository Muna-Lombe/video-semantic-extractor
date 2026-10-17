#!/usr/bin/env python3
"""@type script @purpose Publish compact benchmark evidence without copying media, model weights or raw predictions."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(coco: Path, video: Path, nano: Path, yolo: Path, dino: Path) -> dict:
    benchmark = read(coco)
    models = []
    for path in (nano, yolo):
        report = read(path)
        if report["benchmark_sha256"] != sha(coco):
            raise ValueError("Reports must use the same frozen benchmark.")
        models.append(
            {
                key: report[key]
                for key in (
                    "engine",
                    "benchmark_sha256",
                    "implementation_sha256",
                    "model_sha256",
                    "model_size_bytes",
                    "configuration",
                    "runtime",
                    "metrics",
                    "timing",
                    "class_mapping",
                )
            }
            | {
                "full_report_sha256": sha(path),
                "predictions_sha256": hashlib.sha256(
                    json.dumps(
                        report["predictions"], sort_keys=True, separators=(",", ":")
                    ).encode()
                ).hexdigest(),
            }
        )
    videos = read(video)
    trial = read(dino)
    if trial["video_split_sha256"] != sha(video):
        raise ValueError(
            "Open-vocabulary trial must use the frozen development/holdout split."
        )
    return {
        "schema_version": "reference-benchmark-summary.v1",
        "recorded_date": "2026-10-18",
        "execution": "Local CPU diagnostic runs; no production model or ground-truth approval.",
        "coco": {
            "manifest_sha256": sha(coco),
            **{
                key: benchmark[key]
                for key in (
                    "dataset",
                    "dataset_revision",
                    "split",
                    "selection",
                    "annotations_sha256",
                    "native_annotations_sha256",
                    "native_annotations_url",
                    "class_support",
                    "configuration",
                    "scope",
                )
            },
            "models": models,
        },
        "video": {
            "manifest_sha256": sha(video),
            "catalog_version": videos["catalog_version"],
            "configuration": videos["configuration"],
            "frame_count": videos["frame_count"],
            "status": videos["status"],
            "approval_status": videos["approval_status"],
            "grouping_status": videos["grouping_status"],
            "sources": [
                {
                    key: source[key]
                    for key in ("source", "source_sha256", "group_id", "split")
                }
                | {"frame_count": len(source["frames"])}
                for source in videos["sources"]
            ],
        },
        "open_vocabulary": trial,
        "limitations": [
            "Coverage-selected COCO validation subset; not full official COCO metrics or an untouched holdout.",
            "The video pack has no completed independent human reviews or adjudication; video model accuracy is not established.",
            "Preview tags and Grounding DINO suggestions are not ground truth.",
            "CPU timing and peak process memory describe this environment; production resource qualification remains separate.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("coco", "video", "nano", "yolo", "dino", "output"):
        parser.add_argument("--" + field, type=Path, required=True)
    args = parser.parse_args()
    value = summarize(args.coco, args.video, args.nano, args.yolo, args.dino)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(value, output, indent=2, allow_nan=False)
        output.write("\n")


if __name__ == "__main__":
    main()
