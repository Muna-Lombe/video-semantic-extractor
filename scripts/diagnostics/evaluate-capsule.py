#!/usr/bin/env python3
"""@type script
@purpose Report structural, temporal, and semantic coverage of a generated capsule.
"""

from __future__ import annotations

import argparse
import json
from itertools import pairwise
from pathlib import Path


def main() -> None:
    """Load a capsule and print deterministic diagnostic metrics."""
    parser = argparse.ArgumentParser(description="Evaluate a VideoCapsule JSON file")
    parser.add_argument("capsule", type=Path)
    args = parser.parse_args()

    payload = json.loads(args.capsule.read_text(encoding="utf-8"))
    metadata = payload["metadata"]
    keyframes = payload["keyframes"]
    timestamps = [float(frame["timestamp_sec"]) for frame in keyframes]
    monotonic = timestamps == sorted(timestamps)
    duration = float(metadata["duration_sec"])
    max_gap = max(
        (right - left for left, right in pairwise(timestamps)),
        default=duration,
    )

    print(f"capsule_bytes={args.capsule.stat().st_size}")
    print(f"duration_sec={duration}")
    print(f"transcript_segments={len(payload['transcript']['segments'])}")
    print(f"keyframes={len(keyframes)}")
    print(f"keyframe_timestamps_monotonic={str(monotonic).lower()}")
    print(f"keyframe_first_sec={timestamps[0] if timestamps else 'none'}")
    print(f"keyframe_last_sec={timestamps[-1] if timestamps else 'none'}")
    print(f"keyframe_max_gap_sec={max_gap}")
    print(f"objects={sum(len(frame['objects']) for frame in keyframes)}")
    print(f"actions={sum(len(frame['actions']) for frame in keyframes)}")
    print(f"text_in_frame={sum(len(frame['text_in_frame']) for frame in keyframes)}")
    print(
        "embeddings="
        f"{sum(frame['embedding_int8'] is not None for frame in keyframes)}"
    )
    print(f"entities={len(payload['scene_graph']['entities'])}")
    print(f"relations={len(payload['scene_graph']['relations'])}")
    print(f"warnings={len(payload['warnings'])}")


if __name__ == "__main__":
    main()
