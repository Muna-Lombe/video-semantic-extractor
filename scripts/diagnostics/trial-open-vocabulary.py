#!/usr/bin/env python3
"""@type script @purpose Trial a pinned Grounding DINO conversion; outputs are suggestions, never ground truth."""

from __future__ import annotations

import argparse
import hashlib
import json
import resource
import time
from pathlib import Path

import requests

REPOSITORY = "IDEA-Research/grounding-dino-tiny"
REVISION = "a2bb814dd30d776dcf7e30523b00659f4f141c71"
FILES = [
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "added_tokens.json",
]
PROMPT = (
    "microphone. headphones. camera. wristwatch. tablet. bottle. book. sports ball."
)


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def prepare(model_dir: Path) -> None:
    model_dir.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = model_dir / name
        if path.exists():
            continue
        partial = path.with_suffix(".partial")
        try:
            with requests.get(
                f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}",
                stream=True,
                timeout=(20, 120),
            ) as response:
                response.raise_for_status()
                size = 0
                with partial.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        size += len(chunk)
                        if size > 1024 * 1024 * 1024:
                            raise ValueError("model exceeds trial storage budget")
                        output.write(chunk)
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    (model_dir / "provenance.json").write_text(
        json.dumps(
            {
                "repository": REPOSITORY,
                "revision": REVISION,
                "upstream": "ShilongLiu/GroundingDINO groundingdino_swint_ogc.pth",
                "format": "Transformers conversion; not byte-identical to upstream .pth",
                "files": {name: digest(model_dir / name) for name in FILES},
            },
            indent=2,
        )
        + "\n"
    )


def run(model_dir: Path, image_dir: Path, output: Path, video_plan: Path) -> None:
    import torch
    from PIL import Image
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    if output.exists():
        raise ValueError("trial report exists; use a new output path")
    provenance = json.loads((model_dir / "provenance.json").read_text())
    if any(
        digest(model_dir / name) != sha for name, sha in provenance["files"].items()
    ):
        raise ValueError("model conversion changed")
    chosen = [
        "sample_1-1.jpg",
        "sample_4-0.jpg",
        "sample_10-3.jpg",
        "sample_13-2.jpg",
        "sample_14-3.jpg",
        "sample_15-1.jpg",
        "sample_16-2.jpg",
        "sample_17-2.jpg",
    ]
    split = json.loads(video_plan.read_text())
    development = {
        source["source"]
        for source in split["sources"]
        if source["split"] == "development"
    }
    chosen = [name for name in chosen if name.split("-")[0] in development]
    if not chosen:
        raise ValueError("No development images available for the exploratory trial.")
    plan = {
        "schema_version": "open-vocabulary-trial.v1",
        "video_split_sha256": digest(video_plan),
        "model": provenance,
        "prompt": PROMPT,
        "box_threshold": 0.35,
        "text_threshold": 0.25,
        "device": "cpu",
        "cpu_threads": 2,
        "images": {name: digest(image_dir / name) for name in chosen},
        "scope": "Exploratory unreviewed suggestions on development sources only. No accuracy, unknown-object completeness or production approval claims.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.with_suffix(".plan.json").open("x") as handle:
        json.dump(plan, handle, indent=2)
    torch.set_num_threads(2)
    processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
    model = (
        AutoModelForZeroShotObjectDetection.from_pretrained(
            model_dir, local_files_only=True
        )
        .to("cpu")
        .eval()
    )
    frames = []
    for name in chosen:
        image = Image.open(image_dir / name).convert("RGB")
        start = time.perf_counter()
        inputs = processor(images=image, text=PROMPT, return_tensors="pt")
        with torch.inference_mode():
            predictions = model(**inputs)
        result = processor.post_process_grounded_object_detection(
            predictions,
            inputs.input_ids,
            threshold=0.35,
            text_threshold=0.25,
            target_sizes=[(image.height, image.width)],
        )[0]
        suggestions = [
            {
                "phrase": label,
                "confidence": float(score),
                "region_xyxy": [float(value) for value in box],
            }
            for label, score, box in zip(
                result["text_labels"], result["scores"], result["boxes"]
            )
        ]
        frames.append(
            {
                "filename": name,
                "sha256": plan["images"][name],
                "elapsed_ms": (time.perf_counter() - start) * 1000,
                "suggestions": suggestions,
            }
        )
        print(f"Trial {name}: {len(suggestions)} suggestions", flush=True)
    report = {
        **plan,
        "implementation_sha256": digest(Path(__file__)),
        "frames": frames,
        "peak_process_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        / 1024,
        "timing_note": "Includes preprocessing, inference and postprocessing; first image includes cold execution. Preview images are downscaled and timings are not comparable to the COCO benchmark.",
    }
    with output.open("x") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run"])
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--image-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--video-plan", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.model_dir)
    elif args.image_dir and args.output and args.video_plan:
        run(args.model_dir, args.image_dir, args.output, args.video_plan)
    else:
        parser.error("run requires --image-dir, --output and --video-plan")


if __name__ == "__main__":
    main()
