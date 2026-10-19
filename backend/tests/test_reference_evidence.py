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
    catalog = json.loads((ROOT / "scripts/fixtures/sample-library.v1.json").read_text())
    assert catalog["audit_reports"]
    by_id = {}
    for report in catalog["audit_reports"]:
        audit = json.loads((ROOT / report).read_text())
        assert audit["schema_version"] == "sample-media-audit.v1"
        assert not audit["duplicate_groups"]
        for source in audit["sources"]:
            assert source["id"] not in by_id
            assert source["status"] == "available"
            assert source["full_decode_passed"]
            by_id[source["id"]] = source
    assert len({source["id"] for source in catalog["sources"]}) == len(catalog["sources"])
    assert len({source["sha256"] for source in catalog["sources"]}) == len(catalog["sources"])
    assert {source["id"] for source in catalog["sources"]} == set(by_id)
    for source in catalog["sources"]:
        for field in (
            "url", "sha256", "size_bytes", "duration_seconds", "width", "height",
            "full_decode_passed",
        ):
            assert by_id[source["id"]][field] == source[field]
        assert source["coverage_status"] == "preview_inspected"


def test_frozen_video_benchmark_retains_its_original_audited_catalog():
    frozen_path = VERIFICATION / "2026-10-18-sample-library.json"
    frozen_catalog = json.loads(frozen_path.read_text())
    video = read("video-review-manifest")
    audit = read("sample-media-audit")
    assert video["catalog_sha256"] == sha(frozen_path)
    assert video["catalog_version"] == frozen_catalog["version"]
    assert len(frozen_catalog["sources"]) == len(audit["sources"]) == 17
    assert {source["id"]: source["sha256"] for source in frozen_catalog["sources"]} == {
        source["id"]: source["sha256"] for source in audit["sources"]
    }
    assert {source["source"]: source["source_sha256"] for source in video["sources"]} == {
        source["id"]: source["sha256"] for source in frozen_catalog["sources"]
    }
