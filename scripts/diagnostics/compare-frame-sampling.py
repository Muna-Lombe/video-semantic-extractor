#!/usr/bin/env python3
"""@type script
@purpose Compare scene, fixed-interval, and hybrid frame sampling with review artifacts.
@dependencies ffmpeg, ffprobe, opencv-python-headless, numpy
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path

import cv2
import numpy as np
from video_semantic_extractor.pipeline import extract_keyframes


@dataclass(frozen=True)
class SamplingMetrics:
    """Deterministic temporal and visual metrics for one sampling strategy."""

    frame_count: int
    first_sec: float | None
    last_sec: float | None
    max_gap_sec: float
    mean_gap_sec: float
    adjacent_perceptual_duplicates: int
    unique_file_hashes: int
    transcript_mean_distance_sec: float | None
    transcript_max_distance_sec: float | None


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    """Run a media command and surface its stderr when it fails."""
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise RuntimeError(detail.strip()) from exc


def probe_duration(input_path: Path) -> float:
    """Return the container duration reported by ffprobe."""
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(input_path),
        ]
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def sampling_filters(scene_threshold: float, interval_sec: float) -> dict[str, str]:
    """Build FFmpeg select expressions for the two baseline strategies."""
    return {
        "scene": f"eq(n,0)+gt(scene,{scene_threshold})",
        "fixed": f"eq(n,0)+gte(t-prev_selected_t,{interval_sec})",
    }


def extract_frames(
    input_path: Path, output_dir: Path, select_expr: str
) -> list[tuple[Path, float]]:
    """Extract selected frames with microsecond PTS encoded in their filenames."""
    output_dir.mkdir(parents=True, exist_ok=True)
    for stale_frame in output_dir.glob("frame_*.jpg"):
        stale_frame.unlink()
    pattern = output_dir / "frame_%06d_%013d.jpg"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-vf",
            f"select='{select_expr}',settb=AVTB",
            "-fps_mode",
            "vfr",
            "-enc_time_base",
            "filter",
            "-frame_pts",
            "1",
            str(pattern),
        ]
    )
    frames = sorted(
        output_dir.glob("frame_*.jpg"),
        key=lambda frame: int(frame.stem.rsplit("_", 1)[1]),
    )
    return [(frame, int(frame.stem.rsplit("_", 1)[1]) / 1_000_000) for frame in frames]


def difference_hash(frame_path: Path) -> int:
    """Return a 64-bit difference hash suitable for near-duplicate triage."""
    image = cv2.imread(str(frame_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f"could not decode {frame_path}")
    resized = cv2.resize(image, (9, 8), interpolation=cv2.INTER_AREA)
    bits = resized[:, 1:] > resized[:, :-1]
    value = 0
    for bit in bits.flat:
        value = (value << 1) | int(bit)
    return value


def transcript_midpoints(capsule_path: Path | None) -> list[float]:
    """Read transcript segment midpoints from a capsule when one is supplied."""
    if capsule_path is None:
        return []
    payload = json.loads(capsule_path.read_text(encoding="utf-8"))
    return [
        (float(segment["start_sec"]) + float(segment["end_sec"])) / 2
        for segment in payload["transcript"]["segments"]
    ]


def calculate_metrics(
    frames: Sequence[tuple[Path, float]],
    duration_sec: float,
    speech_midpoints: Sequence[float],
) -> SamplingMetrics:
    """Measure full-duration coverage, duplication, and speech proximity."""
    timestamps = [timestamp for _path, timestamp in frames]
    boundaries = [0.0, *timestamps, duration_sec]
    gaps = [right - left for left, right in pairwise(boundaries)]
    hashes = [difference_hash(path) for path, _timestamp in frames]
    transcript_distances = [
        min(
            (abs(midpoint - timestamp) for timestamp in timestamps),
            default=duration_sec,
        )
        for midpoint in speech_midpoints
    ]
    return SamplingMetrics(
        frame_count=len(frames),
        first_sec=timestamps[0] if timestamps else None,
        last_sec=timestamps[-1] if timestamps else None,
        max_gap_sec=max(gaps, default=duration_sec),
        mean_gap_sec=float(np.mean(gaps)) if gaps else duration_sec,
        adjacent_perceptual_duplicates=sum(
            (left ^ right).bit_count() <= 4 for left, right in pairwise(hashes)
        ),
        unique_file_hashes=len(
            {
                hashlib.sha256(path.read_bytes()).hexdigest()
                for path, _timestamp in frames
            }
        ),
        transcript_mean_distance_sec=(
            float(np.mean(transcript_distances)) if transcript_distances else None
        ),
        transcript_max_distance_sec=(
            max(transcript_distances) if transcript_distances else None
        ),
    )


def write_manifest(
    output_path: Path,
    frames: Sequence[tuple[Path, float]],
    provenance: dict[Path, tuple[str, ...]] | None = None,
) -> None:
    """Write an auditable mapping from extracted files to decoded timestamps."""
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "timestamp_sec", "sampling_reasons"])
        writer.writerows(
            (
                path.name,
                f"{timestamp:.6f}",
                "+".join(provenance.get(path, ())) if provenance else "not_recorded",
            )
            for path, timestamp in frames
        )


def write_contact_sheet(
    output_path: Path, frames: Sequence[tuple[Path, float]], columns: int = 5
) -> None:
    """Create a labeled contact sheet for human review of sampling quality."""
    if not frames:
        return
    tile_width, tile_height, label_height = 240, 180, 28
    rows = math.ceil(len(frames) / columns)
    sheet = np.full(
        (rows * (tile_height + label_height), columns * tile_width, 3), 255, np.uint8
    )
    for index, (path, timestamp) in enumerate(frames):
        image = cv2.imread(str(path))
        if image is None:
            raise RuntimeError(f"could not decode {path}")
        scale = min(tile_width / image.shape[1], tile_height / image.shape[0])
        resized = cv2.resize(
            image,
            (
                max(1, round(image.shape[1] * scale)),
                max(1, round(image.shape[0] * scale)),
            ),
            interpolation=cv2.INTER_AREA,
        )
        row, column = divmod(index, columns)
        x = column * tile_width + (tile_width - resized.shape[1]) // 2
        y = row * (tile_height + label_height) + (tile_height - resized.shape[0]) // 2
        sheet[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
        cv2.putText(
            sheet,
            f"{timestamp:.3f}s",
            (
                column * tile_width + 6,
                row * (tile_height + label_height) + tile_height + 20,
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 0, 0),
            1,
            cv2.LINE_AA,
        )
    if not cv2.imwrite(str(output_path), sheet):
        raise RuntimeError(f"could not write {output_path}")


def main() -> None:
    """Extract all strategies and write machine- and human-reviewable results."""
    parser = argparse.ArgumentParser(
        description="Compare video frame sampling strategies"
    )
    parser.add_argument("input_video", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument(
        "--capsule", type=Path, help="capsule used for transcript proximity"
    )
    parser.add_argument("--interval-sec", type=float, default=5.0)
    parser.add_argument("--scene-threshold", type=float, default=0.3)
    args = parser.parse_args()
    if args.interval_sec <= 0 or not 0 <= args.scene_threshold <= 1:
        parser.error(
            "interval must be positive and scene threshold must be between 0 and 1"
        )
    if not args.input_video.is_file():
        parser.error(f"video does not exist: {args.input_video}")

    args.output_directory.mkdir(parents=True, exist_ok=True)
    duration = probe_duration(args.input_video)
    speech_midpoints = transcript_midpoints(args.capsule)
    report: dict[str, object] = {
        "source": str(args.input_video),
        "duration_sec": duration,
        "scene_threshold": args.scene_threshold,
        "interval_sec": args.interval_sec,
        "transcript_segments": len(speech_midpoints),
        "ocr_changes": "not_measured_analyzer_unavailable",
        "strategies": {},
    }
    strategies = report["strategies"]
    assert isinstance(strategies, dict)
    for name, select_expr in sampling_filters(
        args.scene_threshold, args.interval_sec
    ).items():
        strategy_dir = args.output_directory / name
        frames = extract_frames(args.input_video, strategy_dir / "frames", select_expr)
        metrics = calculate_metrics(frames, duration, speech_midpoints)
        write_manifest(strategy_dir / "manifest.csv", frames)
        write_contact_sheet(strategy_dir / "contact-sheet.jpg", frames)
        strategies[name] = {**metrics.__dict__, "select_expression": select_expr}

    hybrid_dir = args.output_directory / "hybrid"
    hybrid_candidates = extract_keyframes(
        args.input_video,
        hybrid_dir / "frames",
        args.scene_threshold,
        max_keyframes=1_000_000,
        sampling_interval_sec=args.interval_sec,
        duration_sec=duration,
    )
    hybrid_frames = [
        (candidate.path, candidate.timestamp_sec) for candidate in hybrid_candidates
    ]
    provenance = {
        candidate.path: candidate.sampling_reasons for candidate in hybrid_candidates
    }
    hybrid_metrics = calculate_metrics(hybrid_frames, duration, speech_midpoints)
    write_manifest(hybrid_dir / "manifest.csv", hybrid_frames, provenance)
    write_contact_sheet(hybrid_dir / "contact-sheet.jpg", hybrid_frames)
    reason_counts = {
        reason: sum(
            reason in candidate.sampling_reasons for candidate in hybrid_candidates
        )
        for reason in ("first", "scene_change", "interval", "near_final")
    }
    strategies["hybrid"] = {
        **hybrid_metrics.__dict__,
        "selection": "production_candidate_merge",
        "sampling_reason_counts": reason_counts,
    }

    report_path = args.output_directory / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote sampling comparison to {report_path}")


if __name__ == "__main__":
    main()
