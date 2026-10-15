#!/usr/bin/env python3
"""@type script
@purpose Initialize prediction-blind annotations from managed manifests and evidence.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from video_semantic_extractor.managed_manifest import (
    initialize_managed_annotations,
    load_manifest,
    policy_definition_sha256,
    sha256_hex,
)


def main() -> None:
    """Validate downloaded inputs and write an unreviewed annotation template."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--frames-dir", type=Path, required=True)
    parser.add_argument("--policy-version", required=True)
    parser.add_argument("--policy-version-id", required=True)
    parser.add_argument("--policy-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--policy-document", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        manifest = load_manifest(args.manifest)
        digest = sha256_hex(args.manifest.read_bytes())
        if args.manifest_sha256 and args.manifest_sha256 != digest:
            parser.error("manifest checksum does not match --manifest-sha256")
        if args.policy_document:
            document = args.policy_document.read_text(encoding="utf-8")
            if policy_definition_sha256(document) != args.policy_sha256:
                parser.error("policy document checksum does not match --policy-sha256")
        policy = {
            "id": args.policy_version_id,
            "version": args.policy_version,
            "sha256": args.policy_sha256,
        }
        template = initialize_managed_annotations(manifest, policy, digest, args.frames_dir)
        if args.validate_only:
            print(f"Validated {template['validation']['frame_count']} frames")
            return
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w" if args.force else "x", encoding="utf-8") as output:
            output.write(json.dumps(template, indent=2) + "\n")
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Initialized {template['validation']['frame_count']} frames; review remains incomplete")


if __name__ == "__main__":
    main()
