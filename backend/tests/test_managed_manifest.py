"""@type test
@purpose Verify managed manifest validation and template initialization parity.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from video_semantic_extractor.managed_manifest import (
    ManagedManifestError,
    frame_extension,
    frame_filename,
    initialize_managed_annotations,
    policy_definition_sha256,
    sha256_hex,
    validate_managed_manifest,
)

SHA = "a" * 64


def _frame(index: int, *, timestamp: float | None = None, media_type: str = "image/jpeg", frame_id: str | None = None, artifact_id: str | None = None) -> dict:
    return {
        "id": frame_id or f"frame_{index}",
        "timestamp_seconds": index + 1 if timestamp is None else timestamp,
        "reasons": ["first"] if index == 0 else ["interval"],
        "width": 640,
        "height": 360,
        "artifact": {
            "artifact_id": artifact_id or f"artifact_{index}",
            "sha256": SHA,
            "size_bytes": 1,
            "media_type": media_type,
        },
    }


def _manifest(frame_count: int = 2) -> dict:
    return {
        "schema_version": "frame-set-manifest.v1",
        "frame_set_id": "frameset_123",
        "sampling_job_id": "job_123",
        "dataset_version_id": "dsv_123",
        "created_at": "2026-10-03T12:00:00.000Z",
        "engine": {"name": "sampler", "version": "1", "configuration_sha256": SHA},
        "source_count": 1,
        "frame_count": frame_count,
        "sources": [
            {
                "dataset_source_id": "src_123",
                "source_sha256": SHA,
                "size_bytes": 100,
                "duration_seconds": 60,
                "frames": [_frame(index) for index in range(frame_count)],
            }
        ],
    }


def _write_evidence(tmp_path: Path, manifest: dict) -> Path:
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    for source in manifest["sources"]:
        for frame in source["frames"]:
            artifact = frame["artifact"]
            data = hashlib.sha256(str(frame["id"]).encode()).digest()
            artifact["sha256"] = sha256_hex(data)
            artifact["size_bytes"] = len(data)
            (frames_dir / frame_filename(frame)).write_bytes(data)
    return frames_dir


def test_validate_accepts_valid_manifest() -> None:
    assert validate_managed_manifest(_manifest()).valid is True


def test_validate_rejects_unknown_top_level_field() -> None:
    manifest = _manifest()
    manifest["extra"] = True
    result = validate_managed_manifest(manifest)
    assert result.valid is False
    assert any("extra is not allowed" in error for error in result.errors)


def test_validate_rejects_missing_required_field() -> None:
    manifest = _manifest()
    del manifest["sources"]
    result = validate_managed_manifest(manifest)
    assert any("manifest.sources is required" in error for error in result.errors)


@pytest.mark.parametrize("value", [[], {}])
@pytest.mark.parametrize("field", ["source", "frame", "artifact"])
def test_validate_reports_non_string_identifiers(field: str, value: object) -> None:
    manifest = _manifest()
    source = manifest["sources"][0]
    frame = source["frames"][0]
    target, key = {
        "source": (source, "dataset_source_id"),
        "frame": (frame, "id"),
        "artifact": (frame["artifact"], "artifact_id"),
    }[field]
    target[key] = value
    result = validate_managed_manifest(manifest)
    assert not result.valid
    assert any("resource identifier" in error for error in result.errors)


@pytest.mark.parametrize("field", ["duration_seconds", "timestamp_seconds"])
def test_validate_rejects_boolean_numbers(field: str) -> None:
    manifest = _manifest(1)
    source = manifest["sources"][0]
    target = source if field == "duration_seconds" else source["frames"][0]
    target[field] = True
    assert not validate_managed_manifest(manifest).valid


def test_initialize_validates_before_reading_evidence(tmp_path: Path) -> None:
    manifest = _manifest()
    del manifest["sources"][0]["frames"][0]["artifact"]
    policy = {"id": "pv_abc", "version": "1", "sha256": SHA}
    with pytest.raises(ManagedManifestError, match="artifact is required"):
        initialize_managed_annotations(manifest, policy, SHA, tmp_path)


@pytest.mark.parametrize("field", ["id", "version"])
def test_initialize_reports_missing_policy_metadata(field: str) -> None:
    policy = {"id": "pv_abc", "version": "1", "sha256": SHA}
    del policy[field]
    with pytest.raises(ManagedManifestError, match=f"policy.{field}"):
        initialize_managed_annotations(_manifest(), policy, SHA)


def test_validate_rejects_count_mismatch() -> None:
    manifest = _manifest(frame_count=2)
    manifest["frame_count"] = 3
    result = validate_managed_manifest(manifest)
    assert any("frame_count does not match" in error for error in result.errors)


def test_validate_rejects_out_of_order_timestamps() -> None:
    manifest = _manifest(frame_count=2)
    manifest["sources"][0]["frames"][1]["timestamp_seconds"] = 0
    result = validate_managed_manifest(manifest)
    assert any("ordered within its source" in error for error in result.errors)


def test_validate_rejects_nonunique_frame_id() -> None:
    manifest = _manifest(frame_count=1)
    manifest["sources"].append(dict(manifest["sources"][0]))
    manifest["sources"][1]["dataset_source_id"] = "src_456"
    manifest["sources"][1]["frames"] = [_frame(0, timestamp=5, artifact_id="artifact_99")]
    manifest["source_count"] = 2
    manifest["frame_count"] = 2
    result = validate_managed_manifest(manifest)
    assert any("globally unique" in error for error in result.errors)


def test_validate_applies_context_checks() -> None:
    result = validate_managed_manifest(_manifest(), {"frameSetId": "frameset_other"})
    assert any("does not match the finalization request" in error for error in result.errors)


def test_validate_checks_dataset_source_membership() -> None:
    result = validate_managed_manifest(_manifest(), {"datasetSourceIds": ["src_123", "src_456"]})
    assert any("do not exactly cover" in error for error in result.errors)


def test_initialize_matches_hosted_template_shape(tmp_path: Path) -> None:
    manifest = _manifest()
    frames_dir = _write_evidence(tmp_path, manifest)
    policy = {"id": "pv_abc", "version": "2026-09-18", "sha256": SHA}
    template = initialize_managed_annotations(manifest, policy, SHA, frames_dir)
    assert template["schema_version"] == "object-annotations.v1"
    assert template["policy_version"] == "2026-09-18"
    assert template["provenance"] == {
        "frame_set_id": "frameset_123",
        "dataset_version_id": "dsv_123",
        "manifest_sha256": SHA,
        "policy_version_id": "pv_abc",
        "policy_sha256": SHA,
        "generator_version": "object-template.v1",
    }
    assert template["validation"]["valid"] is True
    assert template["validation"]["frame_count"] == 2
    assert template["validation"]["source_count"] == 1
    assert template["validation"]["checks"] == [
        "manifest_schema",
        "manifest_checksum",
        "policy_checksum",
        "source_membership",
        "frame_membership",
        "private_evidence",
    ]
    assert template["review"]["independent_passes"] == 0
    source = template["sources"][0]
    assert source["source"] == "src_123"
    assert source["source_sha256"] == SHA
    frame = source["frames"][0]
    assert frame["filename"] == "frame_0.jpg"
    assert frame["frame_id"] == "frame_0"
    assert frame["width"] == 640
    assert frame["height"] == 360
    assert frame["objects"] == []
    assert frame["out_of_taxonomy"] == []


def test_initialize_rejects_missing_evidence(tmp_path: Path) -> None:
    manifest = _manifest()
    policy = {"id": "pv_abc", "version": "2026-09-18", "sha256": SHA}
    with pytest.raises(ManagedManifestError, match="frame evidence missing"):
        initialize_managed_annotations(manifest, policy, SHA, tmp_path / "empty")


def test_initialize_rejects_evidence_checksum_mismatch(tmp_path: Path) -> None:
    manifest = _manifest()
    frames_dir = _write_evidence(tmp_path, manifest)
    next(frames_dir.iterdir()).write_bytes(b"tampered")
    policy = {"id": "pv_abc", "version": "2026-09-18", "sha256": SHA}
    with pytest.raises(ManagedManifestError, match="checksum mismatch"):
        initialize_managed_annotations(manifest, policy, SHA, frames_dir)


def test_initialize_rejects_bad_manifest_sha(tmp_path: Path) -> None:
    manifest = _manifest()
    frames_dir = _write_evidence(tmp_path, manifest)
    policy = {"id": "pv_abc", "version": "2026-09-18", "sha256": SHA}
    with pytest.raises(ManagedManifestError, match="manifest_sha256"):
        initialize_managed_annotations(manifest, policy, "not-a-digest", frames_dir)


def test_frame_extension_mapping() -> None:
    assert frame_extension("image/jpeg") == "jpg"
    assert frame_extension("image/png") == "png"
    assert frame_extension("image/webp") == "webp"


def test_policy_definition_sha256_matches_js_canonical_form() -> None:
    expected_json = '{"annotation_schema_version":"object-annotations.v1","document":"instructions"}'
    expected = hashlib.sha256(expected_json.encode()).hexdigest()
    assert policy_definition_sha256("  instructions\n") == expected


def test_managed_template_preserves_configured_policy_rules() -> None:
    manifest = _manifest()
    policy = {"id": "pv_rules", "version": "1", "sha256": SHA, "annotation_rules": {"allowed_labels": ["cup", "chair"], "allowed_subsets": ["screen"], "max_objects_per_frame": 10}}
    template = initialize_managed_annotations(manifest, policy, SHA, verify_evidence=False)
    assert template["validation"]["annotation_rules"] == {"allowed_labels": ["chair", "cup"], "allowed_subsets": ["screen"], "max_objects_per_frame": 10}
    policy["annotation_rules"]["allowed_labels"] = ["invented class"]
    with pytest.raises(ManagedManifestError, match="taxonomy"):
        initialize_managed_annotations(manifest, policy, SHA, verify_evidence=False)


def test_policy_checksum_includes_normalized_profile_and_configured_rules() -> None:
    sources = [str(index) * 64 for index in range(1, 6)]
    profile = {"id": "coco-object-diagnostic.v1", "source_sha256": list(reversed(sources))}
    rules = {"allowed_labels": ["cup", "chair"], "max_objects_per_frame": 20}
    expected = {"annotation_schema_version": "object-annotations.v1", "document": "instructions", "validation_profile": {"id": "coco-object-diagnostic.v1", "source_sha256": sources}, "annotation_rules": {"allowed_labels": ["chair", "cup"], "max_objects_per_frame": 20}}
    assert policy_definition_sha256("instructions", validation_profile=profile, annotation_rules=rules) == hashlib.sha256(json.dumps(expected, separators=(",", ":")).encode()).hexdigest()
