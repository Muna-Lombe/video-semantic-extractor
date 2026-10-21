#!/usr/bin/env python3
"""@type script @purpose Prepare frozen LLM comparison inputs and compare recorded answers without inventing measurements."""

import argparse
import json
from pathlib import Path

from video_semantic_extractor.capsule_comparison import (
    compare_answers,
    write_comparison,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "score"))
    parser.add_argument("capsule", type=Path)
    parser.add_argument("questions", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument(
        "--answers", action="append", default=[], metavar="VARIANT=FILE"
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        capsule = args.capsule.read_bytes()
        questions = json.loads(args.questions.read_bytes())
        if args.action == "prepare":
            if args.answers:
                parser.error("Prepare inputs before collecting model answers")
            result = write_comparison(args.directory, capsule, questions)
        else:
            answers = {}
            for entry in args.answers:
                variant, path = entry.split("=", 1)
                if variant in answers:
                    parser.error("Provide each variant's answers only once")
                answers[variant] = json.loads(Path(path).read_bytes())
            result = compare_answers(args.directory, capsule, questions, answers)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    rendered = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n")
    print(rendered)


if __name__ == "__main__":
    main()
