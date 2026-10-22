#!/usr/bin/env python3
"""@type script @purpose Run frozen comparisons with a real Chat Completions compatible model."""

import argparse
import json
import os
from pathlib import Path

import requests
from video_semantic_extractor.capsule_llm import provider_settings, run_comparison


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("capsule", "questions", "directory", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument(
        "--provider", choices=("openai", "cloudflare"), default="openai"
    )
    parser.add_argument("--model")
    parser.add_argument("--endpoint")
    parser.add_argument("--account-id", help="Defaults to CLOUDFLARE_ACCOUNT_ID")
    parser.add_argument(
        "--api-key-env", help="Override the provider's credential variable"
    )
    parser.add_argument("--max-tokens", type=int, default=2048)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    try:
        settings = provider_settings(
            args.provider,
            model=args.model,
            endpoint=args.endpoint,
            account_id=args.account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        )
    except ValueError as exc:
        parser.error(str(exc))
    credential_name = args.api_key_env or settings["api_key_env"]
    credential = os.environ.get(credential_name)
    if not credential:
        parser.error(f"Configure {credential_name} before running the comparison")
    try:
        report = run_comparison(
            args.directory,
            args.capsule.read_bytes(),
            json.loads(args.questions.read_bytes()),
            args.output,
            model=settings["model"],
            api_key=credential,
            endpoint=settings["endpoint"],
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
