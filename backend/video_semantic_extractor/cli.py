"""@type script
@purpose Provide a command-line interface for local capsule extraction.
"""

import argparse
from pathlib import Path

from .pipeline import CapsuleBuilder


def main() -> None:
    """Parse CLI arguments and write a validated capsule as JSON."""
    parser = argparse.ArgumentParser(description="Compress a video into a VideoCapsule")
    parser.add_argument("input_video", type=Path)
    parser.add_argument("--output", type=Path, default=Path("video_capsule.json"))
    parser.add_argument("--scene-threshold", type=float, default=0.3)
    parser.add_argument("--max-keyframes", type=int, default=80)
    args = parser.parse_args()
    capsule = CapsuleBuilder(
        scene_threshold=args.scene_threshold, max_keyframes=args.max_keyframes
    ).build(args.input_video)
    args.output.write_text(capsule.model_dump_json(indent=2), encoding="utf-8")
    print(f"Saved VideoCapsule to {args.output}")


if __name__ == "__main__":
    main()
