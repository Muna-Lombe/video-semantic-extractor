#!/usr/bin/env python3
"""@type script
@purpose Initialize a prediction-blind object annotation fixture from sampling evidence.
@dependencies Python standard library
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any

POLICY_VERSION = "2026-09-18"
EXPECTED_SOURCES = tuple(f"sample_{index}.mp4" for index in range(1, 6))


def _load_sampling_source(sampling_root: Path, source_name: str) -> dict[str, Any]:
    """Build one empty source annotation from checksum-bound hybrid evidence."""
    sampling_directory = sampling_root / Path(source_name).stem
    report_path = sampling_directory / "report.json"
    manifest_path = sampling_directory / "hybrid" / "manifest.csv"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read sampling report {report_path}: {exc}") from exc

    checksum = report.get("source_sha256")
    if (
        not isinstance(checksum, str)
        or len(checksum) != 64
        or any(character not in "0123456789abcdef" for character in checksum)
    ):
        raise ValueError(f"invalid source_sha256 in {report_path}")

    try:
        with manifest_path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
    except OSError as exc:
        raise ValueError(f"cannot read hybrid manifest {manifest_path}: {exc}") from exc
    if not rows:
        raise ValueError(f"hybrid manifest has no frames: {manifest_path}")

    frames: list[dict[str, Any]] = []
    seen_filenames: set[str] = set()
    for row in rows:
        filename = row.get("filename", "")
        if (
            not filename
            or Path(filename).is_absolute()
            or ".." in Path(filename).parts
            or filename in seen_filenames
        ):
            raise ValueError(
                f"unsafe, missing, or duplicate manifest filename: {filename!r}"
            )
        try:
            timestamp = float(row["timestamp_sec"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid timestamp for {source_name}/{filename}") from exc
        if not math.isfinite(timestamp) or timestamp < 0:
            raise ValueError(f"invalid timestamp for {source_name}/{filename}")
        seen_filenames.add(filename)
        frames.append(
            {
                "filename": filename,
                "timestamp_sec": timestamp,
                "objects": [],
                "out_of_taxonomy": [],
            }
        )

    return {
        "source": source_name,
        "source_sha256": checksum,
        "frames": frames,
    }


def initialize_annotations(sampling_root: Path) -> dict[str, Any]:
    """Return a deterministic, explicitly incomplete five-source annotation fixture."""
    return {
        "policy_version": POLICY_VERSION,
        "review": {
            "independent_passes": 0,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "not_started",
            "adjudication_log": [],
        },
        "sources": [
            _load_sampling_source(sampling_root, source_name)
            for source_name in EXPECTED_SOURCES
        ],
    }


def main() -> None:
    """Write an annotation template without exposing or importing predictions."""
    parser = argparse.ArgumentParser(
        description="Initialize a prediction-blind multi-video object annotation fixture"
    )
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("output_annotations", type=Path)
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing output file (never enabled by default)",
    )
    args = parser.parse_args()
    if args.output_annotations.exists() and not args.force:
        parser.error(f"output already exists: {args.output_annotations}")

    try:
        payload = initialize_annotations(args.sampling_root)
    except ValueError as exc:
        parser.error(str(exc))
    args.output_annotations.parent.mkdir(parents=True, exist_ok=True)
    args.output_annotations.write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    frame_count = sum(len(source["frames"]) for source in payload["sources"])
    print(
        f"Initialized {frame_count} frames in {args.output_annotations}; "
        "review remains incomplete"
    )


if __name__ == "__main__":
    main()
