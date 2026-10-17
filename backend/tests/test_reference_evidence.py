"""@type test @purpose Check recorded benchmark provenance and prevent holdout or approval claims drifting from evidence."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parents[2]
VERIFICATION = ROOT / "docs/verification"


def read(name):
    return json.loads((VERIFICATION / f"2026-10-18-{name}.json").read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_reference_models_use_the_same_frozen_inputs_and_shipped_evaluator():
    report = read("reference-benchmarks")
    benchmark = read("coco-reference-manifest")
    assert report["coco"]["manifest_sha256"] == sha(
        VERIFICATION / "2026-10-18-coco-reference-manifest.json"
    )
    assert len(benchmark["images"]) == benchmark["selection"]["count"] == 300
    assert len(set(benchmark["selection"]["image_ids"])) == 300
    assert len(benchmark["class_support"]) == 80
    positives = sum(benchmark["class_support"].values())
    for model in report["coco"]["models"]:
        assert model["benchmark_sha256"] == report["coco"]["manifest_sha256"]
        assert model["implementation_sha256"] == sha(
            ROOT / "scripts/diagnostics/benchmark-corpus.py"
        )
        assert model["metrics"]["true_positives"] + model["metrics"]["false_negatives"] == positives
        assert 0 <= model["metrics"]["map_50_95"] <= 1
        assert all(value["support_images"] > 0 for value in model["metrics"]["classes"].values())


def test_video_holdout_is_separate_and_no_human_approval_is_fabricated():
    report = read("reference-benchmarks")
    video = read("video-review-manifest")
    assert report["video"]["manifest_sha256"] == sha(
        VERIFICATION / "2026-10-18-video-review-manifest.json"
    )
    assert video["implementation_sha256"] == sha(
        ROOT / "scripts/diagnostics/prepare-video-benchmark.py"
    )
    assert video["frame_count"] == sum(len(source["frames"]) for source in video["sources"]) == 254
    assert video["approval_status"] == "pending"
    assert video["status"] == "awaiting_independent_review"
    assert all(not frame["objects"] for source in video["sources"] for frame in source["frames"])
    development = {
        source["group_id"] for source in video["sources"] if source["split"] == "development"
    }
    holdout = {source["group_id"] for source in video["sources"] if source["split"] == "holdout"}
    assert development.isdisjoint(holdout)
    assert len(development) == 12 and len(holdout) == 5
    trial = report["open_vocabulary"]
    assert trial["video_split_sha256"] == report["video"]["manifest_sha256"]
    assert trial["implementation_sha256"] == sha(
        ROOT / "scripts/diagnostics/trial-open-vocabulary.py"
    )
    assert all(filename.split("-")[0] in development for filename in trial["images"])


def test_sample_catalog_is_bound_to_the_successful_media_audit():
    audit = read("sample-media-audit")
    catalog = json.loads((ROOT / "scripts/fixtures/sample-library.v1.json").read_text())
    assert len(catalog["sources"]) == len(audit["sources"]) == 17
    assert not audit["duplicate_groups"]
    assert read("video-review-manifest")["catalog_sha256"] == sha(
        ROOT / "scripts/fixtures/sample-library.v1.json"
    )
    by_id = {source["id"]: source for source in audit["sources"]}
    for source in catalog["sources"]:
        assert by_id[source["id"]]["full_decode_passed"]
        assert by_id[source["id"]]["sha256"] == source["sha256"]
        assert source["coverage_status"] == "preview_inspected"
