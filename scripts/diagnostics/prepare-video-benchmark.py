#!/usr/bin/env python3
"""@type script @purpose Freeze sampled video evidence and blank independent-review inputs without fabricating labels."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
from video_semantic_extractor.pipeline import probe_video
from video_semantic_extractor.sampling_runner import _candidates


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def prepare(
    catalog_path: Path, media_dir: Path, root: Path, seed: str, per_source: int
) -> dict:
    if (root / "benchmark.json").exists():
        raise ValueError("Benchmark already frozen; use a new output directory.")
    catalog = json.loads(catalog_path.read_text())
    sources = catalog["sources"]
    if len({source["sha256"] for source in sources}) != len(sources):
        raise ValueError(
            "Duplicate source bytes must be grouped or removed before freezing."
        )
    if not 1 <= per_source <= 500 // len(sources):
        raise ValueError("Per-source frame budget exceeds the 500-frame managed limit.")
    groups = sorted(
        {source["group_id"] for source in sources},
        key=lambda group: hashlib.sha256(f"{seed}:{group}".encode()).hexdigest(),
    )
    if len(groups) < 6:
        raise ValueError(
            "At least six independent source groups are required for a development/holdout split."
        )
    holdout = set(groups[: max(1, round(len(groups) * 0.3))])
    config = {
        "method": "hybrid",
        "scene_threshold": 0.34,
        "interval_seconds": 5,
        "max_frames": per_source,
        "include_final_frame": True,
    }
    root.mkdir(parents=True, exist_ok=True)
    evidence = []
    for source in sources:
        path = media_dir / f"{source['id']}.mp4"
        if digest(path) != source["sha256"]:
            raise ValueError(f"Source content changed: {source['id']}")
        metadata = probe_video(path)
        with tempfile.TemporaryDirectory(prefix="vse-review-") as temporary:
            candidates = _candidates(
                path, Path(temporary), config, metadata.duration_sec
            )
            frames = []
            for n, candidate in enumerate(candidates):
                filename = f"{source['id']}-{n:04d}.jpg"
                output = root / "frames" / filename
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(candidate.path, output)
                image = cv2.imread(str(output))
                if image is None:
                    raise ValueError("Sampled evidence cannot be decoded.")
                frames.append(
                    {
                        "filename": filename,
                        "frame_id": filename[:-4],
                        "timestamp_sec": candidate.timestamp_sec,
                        "width": int(image.shape[1]),
                        "height": int(image.shape[0]),
                        "sha256": digest(output),
                        "size_bytes": output.stat().st_size,
                        "sampling_reasons": list(candidate.sampling_reasons),
                        "objects": [],
                        "out_of_taxonomy": [],
                    }
                )
        evidence.append(
            {
                "source": source["id"],
                "source_sha256": source["sha256"],
                "group_id": source["group_id"],
                "split": "holdout" if source["group_id"] in holdout else "development",
                "frames": frames,
            }
        )
        print(f"{source['id']}: {len(frames)} frames", flush=True)
    manifest = {
        "schema_version": "video-review-benchmark.v1",
        "catalog_version": catalog["version"],
        "catalog_sha256": digest(catalog_path),
        "implementation_sha256": digest(Path(__file__)),
        "split_seed": seed,
        "grouping_status": "preview_inspected; related-footage grouping requires human confirmation before benchmark approval",
        "configuration": config,
        "frame_count": sum(len(source["frames"]) for source in evidence),
        "sources": evidence,
        "status": "awaiting_independent_review",
        "approval_status": "pending",
        "ffmpeg": subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, text=True, check=True
        ).stdout.splitlines()[0],
    }
    (root / "benchmark.json").write_text(json.dumps(manifest, indent=2) + "\n")
    annotations = {
        "schema_version": "object-annotations.v1",
        "policy_version": "video-review-extended.v1",
        "provenance": {
            "local_manifest_sha256": digest(root / "benchmark.json"),
            "registration_status": "local_unregistered_review_pack",
        },
        "validation": {
            "valid": False,
            "reason": "Two independent human reviews, adjudication and managed validation are required.",
            "annotation_rules": {"taxonomy_version": "coco-extended.v1"},
        },
        "review": {
            "independent_passes": 0,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "not_started",
            "adjudication_log": [],
            "reviewed_frames": [],
        },
        "sources": [
            {k: source[k] for k in ["source", "source_sha256", "frames"]}
            for source in evidence
        ],
    }
    (root / "review-template.json").write_text(json.dumps(annotations, indent=2) + "\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog", type=Path, default=Path("scripts/fixtures/sample-library.v1.json")
    )
    parser.add_argument("--media-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seed", default="vse-video-split-v1")
    parser.add_argument("--frames-per-source", type=int, default=25)
    args = parser.parse_args()
    try:
        manifest = prepare(
            args.catalog,
            args.media_dir,
            args.output_dir,
            args.seed,
            args.frames_per_source,
        )
        print(
            json.dumps(
                {
                    "frames": manifest["frame_count"],
                    "status": manifest["status"],
                    "holdout": [
                        s["source"]
                        for s in manifest["sources"]
                        if s["split"] == "holdout"
                    ],
                }
            )
        )
    except (ValueError, OSError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
