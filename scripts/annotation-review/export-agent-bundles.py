#!/usr/bin/env python3
"""Export one prediction-blind annotation handoff ZIP per source video."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0"


def _read_payload(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _frame_path(sampling_root: Path, source: str, filename: str) -> Path:
    root = (sampling_root / Path(source).stem / "hybrid" / "frames").resolve()
    path = (root / filename).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"unsafe frame path: {source}/{filename}")
    if not path.is_file():
        raise ValueError(f"missing frame image: {source}/{filename}")
    return path


def _schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "video-semantic-extractor/object-agent-annotations-1.0",
        "type": "object",
        "required": ["schema_version", "source", "source_sha256", "frames"],
        "properties": {
            "schema_version": {"const": SCHEMA_VERSION},
            "source": {"type": "string"},
            "source_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            "frames": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["filename", "timestamp_sec", "objects", "out_of_taxonomy"],
                    "properties": {
                        "filename": {"type": "string"},
                        "timestamp_sec": {"type": "number", "minimum": 0},
                        "objects": {"type": "array"},
                        "out_of_taxonomy": {"type": "array"},
                    },
                },
            },
        },
    }


def _readme(source: str) -> str:
    return f"""# Prediction-blind object annotation task: `{source}`

Inspect every image in `frames/` at native resolution. Return one `annotations.jsonc`
file using the exact frame filename and timestamp from the template. Do not use model
predictions, neighboring frames, transcripts, or outside context to infer objects.

For each visible, independently classifiable COCO object at least 8x8 pixels, add:
`id`, `label`, `subset` (`live`, `composited`, or `screen`), and
`region: [x, y, width, height]` in source-image pixels. Clip boxes to visible pixels.
Use an empty `objects` list only after inspecting the whole frame. Record visible
non-COCO concepts in `out_of_taxonomy` as strings or structured notes.

Preserve `source_sha256`, every filename, every timestamp, and frame order. Do not
add images to the response. Do not claim an independent review pass or adjudication;
the local reviewer will record those separately after comparing two handoffs.

The JSONC file may contain `//` comments and trailing commas, but must otherwise be
valid JSON with this shape:

```json
{{
  "schema_version": "1.0",
  "source": "{source}",
  "source_sha256": "<64 lowercase hex characters>",
  "frames": [
    {{
      "filename": "frame_000001.jpg",
      "timestamp_sec": 0.0,
      "objects": [],
      "out_of_taxonomy": []
    }}
  ]
}}
```
"""


def export_bundles(annotation_path: Path, sampling_root: Path, output_root: Path) -> list[Path]:
    payload = _read_payload(annotation_path)
    output_root.mkdir(parents=True, exist_ok=True)
    bundles: list[Path] = []
    for source in payload["sources"]:
        source_name = source["source"]
        frames = []
        image_paths: list[tuple[str, Path]] = []
        for frame in source["frames"]:
            filename = frame["filename"]
            _frame_path(sampling_root, source_name, filename)
            image_paths.append((filename, _frame_path(sampling_root, source_name, filename)))
            frames.append({
                "filename": filename,
                "timestamp_sec": frame["timestamp_sec"],
                "objects": [],
                "out_of_taxonomy": [],
            })
        handoff = {
            "schema_version": SCHEMA_VERSION,
            "source": source_name,
            "source_sha256": source["source_sha256"],
            "frames": frames,
        }
        bundle_path = output_root / f"{Path(source_name).stem}-object-annotation.zip"
        with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("README.md", _readme(source_name))
            archive.writestr("schema.json", json.dumps(_schema(), indent=2) + "\n")
            archive.writestr("annotations.jsonc", json.dumps(handoff, indent=2) + "\n")
            for filename, image_path in image_paths:
                archive.write(image_path, f"frames/{filename}")
        bundles.append(bundle_path)
    return bundles


def main() -> None:
    parser = argparse.ArgumentParser(description="Export per-video annotation handoff ZIPs")
    parser.add_argument("annotations", type=Path)
    parser.add_argument("sampling_root", type=Path)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    for bundle in export_bundles(args.annotations, args.sampling_root, args.output_root):
        print(f"Wrote {bundle}")


if __name__ == "__main__":
    main()