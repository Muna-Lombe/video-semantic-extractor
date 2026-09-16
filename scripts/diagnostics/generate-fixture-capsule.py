#!/usr/bin/env python3
"""@type script
@purpose Exercise full media, audio, transcript, frame, and capsule assembly with deterministic fixture speech.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from video_semantic_extractor.pipeline import CapsuleBuilder


def fixture_transcriber(audio_path: Path) -> dict[str, object]:
    """Validate extracted audio and return timed text known by the fixture."""
    if not audio_path.is_file() or audio_path.stat().st_size == 0:
        raise RuntimeError("fixture audio was not extracted")
    return {
        "language": "en",
        "text": "Welcome. Shop now. Fifteen off.",
        "segments": [
            {"start": 0.0, "end": 3.0, "text": "Welcome."},
            {"start": 3.0, "end": 6.0, "text": "Shop now."},
            {"start": 6.0, "end": 9.0, "text": "Fifteen off."},
        ],
    }


def main() -> None:
    """Build and serialize a capsule without downloading a speech model."""
    parser = argparse.ArgumentParser(description="Build a diagnostic fixture capsule")
    parser.add_argument("input_video", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    capsule = CapsuleBuilder(transcriber=fixture_transcriber).build(args.input_video)
    args.output.write_text(capsule.model_dump_json(indent=2), encoding="utf-8")
    print(f"Saved diagnostic VideoCapsule to {args.output}")


if __name__ == "__main__":
    main()
