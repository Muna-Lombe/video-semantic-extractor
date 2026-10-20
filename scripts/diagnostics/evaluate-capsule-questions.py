#!/usr/bin/env python3
"""@type script @purpose Evaluate recorded LLM answers against frozen source-bound capsule questions."""

import argparse
import json
from pathlib import Path

from video_semantic_extractor.capsule_evaluation import score_answers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capsule", type=Path)
    parser.add_argument("questions", type=Path)
    parser.add_argument("--answers", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = score_answers(
            args.capsule.read_bytes(),
            json.loads(args.questions.read_text()),
            json.loads(args.answers.read_text()) if args.answers else None,
        )
    except (ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    rendered = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n")
    print(rendered)


if __name__ == "__main__":
    main()
