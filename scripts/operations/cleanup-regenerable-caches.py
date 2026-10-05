#!/usr/bin/env python3
"""Safely reclaim space by clearing only pip and npm download caches."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def directory_size(path: Path) -> int:
    if path.is_symlink() or not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, directories, files in os.walk(path, followlinks=False):
        directories[:] = [
            name for name in directories if not (Path(root) / name).is_symlink()
        ]
        for name in files:
            file_path = Path(root) / name
            try:
                if not file_path.is_symlink():
                    total += file_path.stat().st_size
            except OSError:
                continue
    return total


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GiB"


def run_cleanup(label: str, command: list[str], estimated_bytes: int) -> None:
    print(f"Cleaning {label} (about {human_size(estimated_bytes)})")
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError as exc:
        raise RuntimeError(f"required command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"{label} cleanup failed with exit code {exc.returncode}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Preview safe pip/npm cache cleanup. No files are removed unless "
            "--apply is supplied."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="clear only the pip and npm package download caches",
    )
    args = parser.parse_args()

    pip_cache = Path.home() / ".cache" / "pip"
    npm = shutil.which("npm")
    targets = [
        ("pip download cache", pip_cache, [sys.executable, "-m", "pip", "cache", "purge"]),
        (
            "npm package cache",
            Path.home() / ".npm" / "_cacache",
            [npm, "cache", "clean", "--force"] if npm else [],
        ),
    ]

    estimates = [(label, path, command, directory_size(path)) for label, path, command in targets]
    estimated_total = sum(size for _, _, _, size in estimates)
    for label, path, command, size in estimates:
        action = "available to purge" if command else "skipped: npm command unavailable"
        print(f"{label}: {human_size(size)} at {path} ({action})")

    print(f"Estimated reclaimable package-cache space: {human_size(estimated_total)}")
    print("Preserved: source files, Git history, media, model data, virtual environments,")
    print("           Copilot data, npm's _npx tools, Docker images, containers, and volumes.")

    if not args.apply:
        print("Preview only. Re-run with --apply to clear the two package caches.")
        return 0

    for label, _path, command, size in estimates:
        if not command:
            if label == "npm package cache":
                print("Skipping npm package cache because npm is unavailable.")
            continue
        run_cleanup(label, command, size)

    remaining = sum(directory_size(path) for _, path, _, _ in targets)
    print(f"Cleanup complete; remaining pip/npm cache size: {human_size(remaining)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"cleanup failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
