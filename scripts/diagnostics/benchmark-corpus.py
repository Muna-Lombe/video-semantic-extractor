#!/usr/bin/env python3
"""@type script @purpose Freeze COCO subsets and compare real CPU detectors with native COCO scoring."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import platform
import resource
import sys
import time
import zipfile
from collections import Counter
from importlib.metadata import version
from pathlib import Path

import cv2
import numpy as np
import requests

DATASET_REVISION = "cf0b22332314a937e9dc8a1957b21725430bb41d"
YOLO_REVISION = "1c54df960929cce45fd6757a8412dfa9106bdbb5"
DATASET_BASE = f"https://huggingface.co/datasets/detection-datasets/coco/resolve/{DATASET_REVISION}/"
VAL_SHARDS = [
    "data/val-00000-of-00002-c4f2e391ee4aba11.parquet",
    "data/val-00001-of-00002-7af5414a3b178949.parquet",
]


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def download(url: str, path: Path, maximum: int = 1024 * 1024 * 1024) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".partial")
    try:
        with requests.get(url, stream=True, timeout=(20, 120)) as response:
            response.raise_for_status()
            size = 0
            with partial.open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    size += len(chunk)
                    if size > maximum:
                        raise ValueError("download exceeds storage budget")
                    output.write(chunk)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def select_images(
    images: list[dict], annotations: list[dict], count: int, seed: str
) -> list[int]:
    """Coverage-guided selection is fixed using labels alone, before any predictions."""
    if not 1 <= count <= len(images):
        raise ValueError("count must be within the available image count")
    by_image = {item["id"]: Counter() for item in images}
    for ann in annotations:
        if ann["image_id"] in by_image and not ann.get("iscrowd", 0):
            by_image[ann["image_id"]][ann["category_id"]] += 1
    ordered = sorted(
        by_image,
        key=lambda value: hashlib.sha256(f"{seed}:{value}".encode()).hexdigest(),
    )
    selected, support = [], Counter()
    while len(selected) < count:
        # Reward independent-image support; avoid repeatedly selecting a crowded scene.
        best = max(
            ordered,
            key=lambda image: sum(
                1 / (1 + support[category]) ** 2 for category in by_image[image]
            ),
        )
        selected.append(best)
        support.update(by_image[best].keys())
        ordered.remove(best)
    return selected


def prepare(root: Path, count: int, seed: str) -> dict:
    import pyarrow.parquet as pq

    if (root / "benchmark.json").exists():
        raise ValueError("benchmark already frozen; use a new output directory")
    cache = root / "cache"
    shards = []
    image_ids = []
    for filename in VAL_SHARDS:
        path = cache / Path(filename).name
        download(DATASET_BASE + filename, path)
        ids = pq.read_table(path, columns=["image_id"])["image_id"].to_pylist()
        image_ids.extend(ids)
        shards.append(
            {"path": str(path), "file": filename, "sha256": digest(path), "ids": ids}
        )
    # The mirror omits iscrowd. Retain authoritative native annotations for valid AP.
    archive = cache / "annotations_trainval2017.zip"
    download(
        "https://images.cocodataset.org/annotations/annotations_trainval2017.zip",
        archive,
    )
    with zipfile.ZipFile(archive) as source:
        annotations_bytes = source.read("annotations/instances_val2017.json")
    official = json.loads(annotations_bytes)
    known_ids = set(image_ids)
    images = [item for item in official["images"] if item["id"] in known_ids]
    ids = select_images(images, official["annotations"], count, seed)
    selected_ids = set(ids)
    native = {
        **official,
        "images": [item for item in images if item["id"] in selected_ids],
        "annotations": [
            item for item in official["annotations"] if item["image_id"] in selected_ids
        ],
    }
    output_images = root / "images"
    output_images.mkdir(parents=True, exist_ok=True)
    checksums = {}
    for shard in shards:
        selected_rows = [
            n for n, image_id in enumerate(shard["ids"]) if image_id in selected_ids
        ]
        if not selected_rows:
            continue
        table = pq.read_table(shard["path"], columns=["image_id", "image"]).take(
            selected_rows
        )
        for row in table.to_pylist():
            path = output_images / f"{row['image_id']}.jpg"
            payload = row["image"]["bytes"]
            path.write_bytes(payload)
            image = cv2.imread(str(path))
            expected = next(
                item for item in native["images"] if item["id"] == row["image_id"]
            )
            if image is None or image.shape[:2] != (
                expected["height"],
                expected["width"],
            ):
                raise ValueError(f"image dimensions mismatch: {row['image_id']}")
            checksums[str(row["image_id"])] = {
                "sha256": digest(path),
                "size_bytes": len(payload),
            }
    if len(checksums) != count:
        raise ValueError("incomplete image extraction")
    annotation_path = root / "annotations.json"
    annotation_path.write_text(json.dumps(native, separators=(",", ":")))
    support = Counter(
        ann["category_id"] for ann in native["annotations"] if not ann.get("iscrowd", 0)
    )
    manifest = {
        "schema_version": "coco-reference-benchmark.v1",
        "dataset": "detection-datasets/coco",
        "dataset_revision": DATASET_REVISION,
        "split": "val",
        "selection": {
            "method": "inverse-independent-image-support.v1",
            "seed": seed,
            "count": count,
            "image_ids": ids,
        },
        "annotations_sha256": digest(annotation_path),
        "native_annotations_sha256": hashlib.sha256(annotations_bytes).hexdigest(),
        "native_annotations_url": "https://images.cocodataset.org/annotations/annotations_trainval2017.zip",
        "shards": [
            {k: v for k, v in item.items() if k not in {"ids", "path"}}
            for item in shards
        ],
        "images": checksums,
        "class_support": {
            cat["name"]: support[cat["id"]] for cat in native["categories"]
        },
        "configuration": {
            "ap_minimum_confidence": 0.001,
            "point_confidence": 0.35,
            "nms_threshold": 0.6,
            "point_iou": 0.5,
            "max_detections": 100,
            "cpu_threads": 2,
        },
        "scope": "Coverage-selected validation subset; not the full official COCO benchmark or an untouched holdout. Video and extended taxonomy coverage are evaluated separately.",
    }
    (root / "benchmark.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def score_coco(
    native: dict, predictions: list[dict], image_ids: list[int], point_confidence: float
) -> dict:
    from pycocotools.coco import COCO
    from pycocotools.cocoeval import COCOeval

    with contextlib.redirect_stdout(io.StringIO()):
        truth = COCO()
        truth.dataset = native
        truth.createIndex()
        if predictions:
            detected = truth.loadRes(predictions)
        else:
            detected = COCO()
            detected.dataset = {
                "images": native["images"],
                "categories": native["categories"],
                "annotations": [],
            }
            detected.createIndex()
        evaluator = COCOeval(truth, detected, "bbox")
        evaluator.params.imgIds = image_ids
        evaluator.evaluate()
        evaluator.accumulate()
        evaluator.summarize()
    support = Counter(
        ann["category_id"] for ann in native["annotations"] if not ann.get("iscrowd", 0)
    )
    classes = {}
    for index, category_id in enumerate(evaluator.params.catIds):
        precision = evaluator.eval["precision"][:, :, index, 0, -1]
        usable = precision[precision >= 0]
        independent_images = {
            ann["image_id"]
            for ann in native["annotations"]
            if ann["category_id"] == category_id and not ann.get("iscrowd", 0)
        }
        classes[truth.cats[category_id]["name"]] = {
            "support": support[category_id],
            "support_images": len(independent_images),
            "ap_50_95": float(usable.mean()) if usable.size else None,
        }
    point_predictions = [
        item for item in predictions if item["score"] >= point_confidence
    ]
    with contextlib.redirect_stdout(io.StringIO()):
        if point_predictions:
            point_detected = truth.loadRes(point_predictions)
        else:
            point_detected = COCO()
            point_detected.dataset = {
                "images": native["images"],
                "categories": native["categories"],
                "annotations": [],
            }
            point_detected.createIndex()
        point = COCOeval(truth, point_detected, "bbox")
        point.params.imgIds = image_ids
        point.params.iouThrs = np.array([0.5])
        point.evaluate()
    tp = fp = positives = 0
    for item in point.evalImgs:
        if item is None or item["aRng"] != point.params.areaRng[0]:
            continue
        valid = ~item["dtIgnore"][0]
        tp += int(np.count_nonzero(item["dtMatches"][0][valid]))
        fp += int(np.count_nonzero(item["dtMatches"][0][valid] == 0))
        positives += int(np.count_nonzero(~np.asarray(item["gtIgnore"], dtype=bool)))
    fn = positives - tp
    return {
        "map_50_95": float(evaluator.stats[0]),
        "map_50": float(evaluator.stats[1]),
        "precision_at_035": tp / (tp + fp) if tp + fp else None,
        "recall_at_035": tp / positives if positives else None,
        "f1_at_035": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "classes": classes,
    }


def load_nanodet(model: Path, confidence: float, nms: float):
    spec = importlib.util.spec_from_file_location(
        "corpus_nanodet", Path(__file__).with_name("evaluate-frame-objects.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.NanoDet(model, confidence, nms)


def evaluate(root: Path, engine: str, model: Path, output: Path) -> dict:
    if output.exists():
        raise ValueError("report already exists; use a new report path")
    manifest_path = root / "benchmark.json"
    manifest = json.loads(manifest_path.read_text())
    if digest(root / "annotations.json") != manifest["annotations_sha256"]:
        raise ValueError("frozen annotations changed")
    native = json.loads((root / "annotations.json").read_text())
    config = manifest["configuration"]
    cv2.setNumThreads(config["cpu_threads"])
    by_name = {cat["name"]: cat["id"] for cat in native["categories"]}
    if engine == "nanodet":
        detector = load_nanodet(
            model, config["ap_minimum_confidence"], config["nms_threshold"]
        )

        def infer(image):
            observations, _latency = detector(image)
            return [
                {
                    "category_id": by_name[item.label],
                    "bbox": list(item.region),
                    "score": item.confidence,
                }
                for item in observations
            ]
    else:
        import torch
        from ultralytics import YOLO

        torch.set_num_threads(config["cpu_threads"])
        detector = YOLO(str(model), task="detect")
        # This publisher's checkpoint stores numeric names; its model card declares
        # the standard contiguous COCO-80 order. Never infer semantic labels from predictions.
        canonical_names = [
            cat["name"]
            for cat in sorted(native["categories"], key=lambda item: item["id"])
        ]
        if len(detector.names) != 80 or len(canonical_names) != 80:
            raise ValueError("YOLOv10 requires the declared 80-class COCO mapping")
        if all(detector.names[i] == str(i) for i in range(80)):
            detector.model.names = dict(enumerate(canonical_names))
        if [detector.names[i] for i in range(80)] != canonical_names:
            raise ValueError(
                "checkpoint class mapping differs from the declared COCO order"
            )

        def infer(image):
            result = detector.predict(
                image,
                device="cpu",
                imgsz=640,
                conf=config["ap_minimum_confidence"],
                iou=config["nms_threshold"],
                max_det=config["max_detections"],
                verbose=False,
            )[0]
            boxes = result.boxes
            return [
                {
                    "category_id": by_name[detector.names[int(cls)]],
                    "bbox": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                    "score": float(score),
                }
                for (x1, y1, x2, y2), cls, score in zip(
                    boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist()
                )
            ]

    ids = manifest["selection"]["image_ids"]
    for _ in range(3):
        infer(cv2.imread(str(root / "images" / f"{ids[0]}.jpg")))
    predictions, timings = [], []
    for index, image_id in enumerate(ids):
        path = root / "images" / f"{image_id}.jpg"
        if digest(path) != manifest["images"][str(image_id)]["sha256"]:
            raise ValueError(f"frozen image changed: {image_id}")
        image = cv2.imread(str(path))
        if image is None:
            raise ValueError(f"image decoding failed: {image_id}")
        start = time.perf_counter()
        detected = sorted(infer(image), key=lambda item: item["score"], reverse=True)[
            : config["max_detections"]
        ]
        timings.append((time.perf_counter() - start) * 1000)
        predictions.extend({"image_id": image_id, **item} for item in detected)
        if (index + 1) % 50 == 0:
            print(f"{engine}: {index + 1}/{len(ids)}", flush=True)
    metrics = score_coco(native, predictions, ids, config["point_confidence"])
    report = {
        "schema_version": "corpus-model-comparison.v1",
        "benchmark_sha256": digest(manifest_path),
        "implementation_sha256": digest(Path(__file__)),
        "engine": engine,
        "model_sha256": digest(model),
        "model_size_bytes": model.stat().st_size,
        "configuration": config,
        "runtime": {
            "python": platform.python_version(),
            "opencv": cv2.__version__,
            "platform": platform.platform(),
            "device": "cpu",
        },
        "metrics": metrics,
        "timing": {
            "warmup_runs": 3,
            "includes": "preprocessing, inference and postprocessing; excludes image disk read and scoring",
            "mean_ms": float(np.mean(timings)),
            "p95_ms": float(np.percentile(timings, 95)),
            "peak_process_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            / 1024,
        },
        "predictions": predictions,
        "image_timings_ms": dict(zip(map(str, ids), timings)),
        "scope": manifest["scope"],
    }
    report["runtime"]["dependencies"] = {
        name: version(name)
        for name in [
            "numpy",
            "pycocotools",
            *(["torch", "torchvision", "ultralytics"] if engine == "yolov10" else []),
        ]
    }
    report["class_mapping"] = (
        "Native COCO category IDs; YOLO contiguous 0–79 IDs use the publisher model card mapping, independently checked against native category order."
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
        handle.write("\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--output-dir", type=Path, required=True)
    prepare_parser.add_argument("--count", type=int, default=300)
    prepare_parser.add_argument("--seed", default="vse-coco-reference-v1")
    run_parser = commands.add_parser("evaluate")
    run_parser.add_argument("--benchmark-dir", type=Path, required=True)
    run_parser.add_argument("--engine", choices=["nanodet", "yolov10"], required=True)
    run_parser.add_argument("--model", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    model_parser = commands.add_parser("download-yolo")
    model_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare(args.output_dir, args.count, args.seed)
            print(
                json.dumps(
                    {
                        "images": len(result["images"]),
                        "class_support": result["class_support"],
                    }
                ),
                flush=True,
            )
        elif args.command == "download-yolo":
            download(
                f"https://huggingface.co/kadirnar/Yolov10/resolve/{YOLO_REVISION}/yolov10n.pt",
                args.output,
                maximum=64 * 1024 * 1024,
            )
            print(
                json.dumps(
                    {
                        "sha256": digest(args.output),
                        "revision": YOLO_REVISION,
                        "license": "agpl-3.0",
                    }
                )
            )
        else:
            result = evaluate(args.benchmark_dir, args.engine, args.model, args.output)
            print(
                json.dumps(
                    {
                        "engine": result["engine"],
                        "metrics": {
                            k: v for k, v in result["metrics"].items() if k != "classes"
                        },
                        "timing": result["timing"],
                    }
                ),
                flush=True,
            )
    except (ValueError, OSError, requests.RequestException) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
