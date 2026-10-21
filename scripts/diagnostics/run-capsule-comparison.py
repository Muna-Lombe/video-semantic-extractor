#!/usr/bin/env python3
"""@type script @purpose Run frozen comparisons with a real Chat Completions compatible model."""

import argparse
import json
import os
from pathlib import Path

import requests
from video_semantic_extractor.capsule_llm import run_comparison


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("capsule", "questions", "directory", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--endpoint", default="https://api.openai.com/v1/chat/completions"
    )
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    try:
        report = run_comparison(
            args.directory,
            args.capsule.read_bytes(),
            json.loads(args.questions.read_bytes()),
            args.output,
            model=args.model,
            api_key=os.environ.get(args.api_key_env),
            endpoint=args.endpoint,
            max_tokens=args.max_tokens,
            timeout=args.timeout,
        )
    except (
        ValueError,
        KeyError,
        TypeError,
        IndexError,
        OSError,
        requests.RequestException,
    ) as exc:
        # Network exceptions can contain proxy/URL details; raw responses remain in output.
        parser.exit(
            1,
            f"Comparison stopped ({type(exc).__name__}); inspect retained run files.\n",
        )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
