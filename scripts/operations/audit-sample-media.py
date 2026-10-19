#!/usr/bin/env python3
"""@type script @purpose Audit sample media bytes and decoding without inventing annotations."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import requests


def audit(index: int, base: str, root: Path) -> dict:
    url = f"{base.rstrip('/')}/sample_{index}.mp4"
    path = root / f"sample_{index}.mp4"
    row = {"id": f"sample_{index}", "url": url, "coverage_status": "unreviewed"}
    try:
        if not path.exists():
            partial = path.with_suffix(".partial")
            try:
                with requests.get(url, timeout=(15, 60), stream=True) as response:
                    response.raise_for_status()
                    total = 0
                    with partial.open("wb") as output:
                        for chunk in response.iter_content(1024 * 1024):
                            total += len(chunk)
                            if total > 512 * 1024 * 1024:
                                raise ValueError("source exceeds 512 MiB audit budget")
                            output.write(chunk)
                partial.replace(path)
            finally:
                partial.unlink(missing_ok=True)
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
        metadata = json.loads(probe.stdout)
        stream = metadata["streams"][0]
        duration = float(metadata["format"]["duration"])
        decoded = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-xerror",
                "-threads",
                "1",
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if decoded.returncode:
            raise ValueError("full decode failed: " + decoded.stderr[-2000:])
        previews = []
        for n, fraction in enumerate((0.1, 0.35, 0.6, 0.85)):
            image = root / f"sample_{index}-{n}.jpg"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-threads",
                    "1",
                    "-ss",
                    str(duration * fraction),
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=320:-2",
                    "-y",
                    str(image),
                ],
                check=True,
                capture_output=True,
                timeout=60,
            )
            previews.append(
                {
                    "filename": image.name,
                    "timestamp_seconds": round(duration * fraction, 3),
                }
            )
        row.update(
            status="available",
            sha256=digest,
            size_bytes=path.stat().st_size,
            duration_seconds=duration,
            width=stream["width"],
            height=stream["height"],
            full_decode_passed=True,
            previews=previews,
        )
    except (
        requests.RequestException,
        OSError,
        ValueError,
        subprocess.SubprocessError,
        KeyError,
        IndexError,
    ) as error:
        row.update(status="failed", error=str(error))
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="https://pub-f402b333934c4b279fdf90faf5864e0a.r2.dev/videos",
    )
    parser.add_argument("--start-index", type=int, default=1)
    parser.add_argument("--count", type=int, default=27)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if (
        not 1 <= args.start_index <= 100
        or not 1 <= args.count <= 100
        or args.start_index + args.count - 1 > 100
    ):
        parser.error("start-index and count must select samples within 1-100")
    root = args.output_dir
    root.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(
            pool.map(
                lambda index: audit(index, args.base_url, root),
                range(args.start_index, args.start_index + args.count),
            )
        )
    by_hash: dict[str, list[str]] = {}
    for row in rows:
        if row.get("sha256"):
            by_hash.setdefault(row["sha256"], []).append(row["id"])
    report = {
        "schema_version": "sample-media-audit.v1",
        "created_at": datetime.now(UTC).isoformat(),
        "sources": rows,
        "duplicate_groups": [ids for ids in by_hash.values() if len(ids) > 1],
        "coverage_note": "Preview inspection is provisional; only independent reviewed annotations establish class support.",
    }
    (root / "audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "sources": len(rows),
                "available": sum(row["status"] == "available" for row in rows),
                "duplicates": report["duplicate_groups"],
            }
        ),
        flush=True,
    )
    if any(row["status"] != "available" for row in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
