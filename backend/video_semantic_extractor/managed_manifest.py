"""@type implementation
@purpose Validate frame-set-manifest.v1 documents and initialize prediction-blind
managed annotation templates locally, mirroring the hosted template generator.

The hosted generator lives in `workers/control-plane/src/template-registry.ts`.
This module ports the manifest contract (`frame-set-manifest.v1`) and the
`object-annotations.v1` template shape so operators can reproduce managed template
initialization from downloaded manifests and frame evidence without changing the
hosted contract.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

FRAME_SET_MANIFEST_VERSION = "frame-set-manifest.v1"
ANNOTATION_SCHEMA_VERSION = "object-annotations.v1"
GENERATOR_VERSION = "object-template.v1"

FRAME_MEDIA_TYPES = ("image/jpeg", "image/png", "image/webp")
SAMPLING_REASONS = ("first", "scene_change", "interval", "near_final")

_ID = re.compile(r"^[a-z][a-z0-9_]{1,99}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")

MANIFEST_KEYS = (
    "schema_version",
    "frame_set_id",
    "sampling_job_id",
    "dataset_version_id",
    "created_at",
    "engine",
    "source_count",
    "frame_count",
    "sources",
)
ENGINE_KEYS = ("name", "version", "configuration_sha256")
SOURCE_KEYS = ("dataset_source_id", "source_sha256", "size_bytes", "duration_seconds", "frames")
FRAME_KEYS = ("id", "timestamp_seconds", "reasons", "width", "height", "artifact")
ARTIFACT_KEYS = ("artifact_id", "sha256", "size_bytes", "media_type")


class ManagedManifestError(ValueError):
    """Raised when a managed manifest or its local evidence is unusable."""


@dataclass(frozen=True)
class ManifestValidationResult:
    valid: bool
    errors: list[str]


def sha256_hex(data: str | bytes) -> str:
    """Return the lowercase SHA-256 digest of text or bytes."""
    payload = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(payload).hexdigest()


def _object(value: Any) -> bool:
    return isinstance(value, Mapping)


def _positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _identifier(value: Any) -> bool:
    return isinstance(value, str) and bool(_ID.fullmatch(value))


def _checksum(value: Any) -> bool:
    return isinstance(value, str) and bool(_SHA256.fullmatch(value))


def _exact_keys(value: Any, allowed: tuple[str, ...], path: str, errors: list[str]) -> None:
    if not _object(value):
        return
    allowed_set = set(allowed)
    for key in value:
        if key not in allowed_set:
            errors.append(f"{path}.{key} is not allowed")
    for key in allowed:
        if key not in value:
            errors.append(f"{path}.{key} is required")


def validate_managed_manifest(
    value: Any,
    context: Mapping[str, Any] | None = None,
) -> ManifestValidationResult:
    """Validate a frame-set-manifest.v1 document against the hosted contract.

    Mirrors `validateFrameSetManifest` in `frame-set-manifest.ts`. Artifact
    existence, object bytes, and checksums must additionally be verified against
    local evidence or R2; this function performs structural validation only.
    """
    context = context or {}
    errors: list[str] = []
    if not _object(value):
        return ManifestValidationResult(False, ["manifest must be an object"])
    _exact_keys(value, MANIFEST_KEYS, "manifest", errors)
    if value.get("schema_version") != FRAME_SET_MANIFEST_VERSION:
        errors.append(f"manifest.schema_version must equal {FRAME_SET_MANIFEST_VERSION}")
    if not _identifier(value.get("frame_set_id")):
        errors.append("manifest.frame_set_id must be a resource identifier")
    if not _identifier(value.get("sampling_job_id")):
        errors.append("manifest.sampling_job_id must be a resource identifier")
    if not _identifier(value.get("dataset_version_id")):
        errors.append("manifest.dataset_version_id must be a resource identifier")
    created_at = value.get("created_at")
    if not isinstance(created_at, str) or not _is_iso_timestamp(created_at):
        errors.append("manifest.created_at must be an ISO-8601 timestamp")
    if context.get("frameSetId") is not None and value.get("frame_set_id") != context["frameSetId"]:
        errors.append("manifest.frame_set_id does not match the finalization request")
    if context.get("samplingJobId") is not None and value.get("sampling_job_id") != context["samplingJobId"]:
        errors.append("manifest.sampling_job_id does not match the leased job")
    if context.get("datasetVersionId") is not None and value.get("dataset_version_id") != context["datasetVersionId"]:
        errors.append("manifest.dataset_version_id does not match the job input")

    engine = value.get("engine")
    if not _object(engine):
        errors.append("manifest.engine must be an object")
    else:
        _exact_keys(engine, ENGINE_KEYS, "manifest.engine", errors)
        name = engine.get("name")
        if not isinstance(name, str) or not 1 <= len(name) <= 100:
            errors.append("manifest.engine.name must contain 1-100 characters")
        version = engine.get("version")
        if not isinstance(version, str) or not 1 <= len(version) <= 100:
            errors.append("manifest.engine.version must contain 1-100 characters")
        if not _checksum(engine.get("configuration_sha256")):
            errors.append("manifest.engine.configuration_sha256 must be a lowercase SHA-256 digest")

    if not _positive_integer(value.get("source_count")):
        errors.append("manifest.source_count must be a positive integer")
    if not _positive_integer(value.get("frame_count")):
        errors.append("manifest.frame_count must be a positive integer")
    sources = value.get("sources")
    if not isinstance(sources, list) or not sources:
        errors.append("manifest.sources must be a non-empty array")
        return ManifestValidationResult(False, errors)

    source_ids: set[str] = set()
    frame_ids: set[str] = set()
    artifact_ids: set[str] = set()
    counted_frames = 0
    for source_index, candidate in enumerate(sources):
        path = f"manifest.sources[{source_index}]"
        if not _object(candidate):
            errors.append(f"{path} must be an object")
            continue
        _exact_keys(candidate, SOURCE_KEYS, path, errors)
        dataset_source_id = candidate.get("dataset_source_id")
        if not _identifier(dataset_source_id):
            errors.append(f"{path}.dataset_source_id must be a resource identifier")
        elif dataset_source_id in source_ids:
            errors.append(f"{path}.dataset_source_id must be unique")
        if _identifier(dataset_source_id):
            source_ids.add(dataset_source_id)
        if not _checksum(candidate.get("source_sha256")):
            errors.append(f"{path}.source_sha256 must be a lowercase SHA-256 digest")
        if not _positive_integer(candidate.get("size_bytes")):
            errors.append(f"{path}.size_bytes must be a positive integer")
        duration = candidate.get("duration_seconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            errors.append(f"{path}.duration_seconds must be greater than zero")
        frames = candidate.get("frames")
        if not isinstance(frames, list) or not frames:
            errors.append(f"{path}.frames must be a non-empty array")
            continue
        previous_timestamp = -1.0
        for frame_index, frame_candidate in enumerate(frames):
            counted_frames += 1
            frame_path = f"{path}.frames[{frame_index}]"
            if not _object(frame_candidate):
                errors.append(f"{frame_path} must be an object")
                continue
            _exact_keys(frame_candidate, FRAME_KEYS, frame_path, errors)
            frame_id = frame_candidate.get("id")
            if not _identifier(frame_id):
                errors.append(f"{frame_path}.id must be a resource identifier")
            elif frame_id in frame_ids:
                errors.append(f"{frame_path}.id must be globally unique")
            if _identifier(frame_id):
                frame_ids.add(frame_id)
            timestamp = frame_candidate.get("timestamp_seconds")
            if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp < 0:
                errors.append(f"{frame_path}.timestamp_seconds must be a non-negative number")
            else:
                if timestamp < previous_timestamp:
                    errors.append(f"{frame_path}.timestamp_seconds must be ordered within its source")
                if isinstance(duration, (int, float)) and math.isfinite(duration) and timestamp > duration:
                    errors.append(f"{frame_path}.timestamp_seconds exceeds the source duration")
                previous_timestamp = float(timestamp)
            reasons = frame_candidate.get("reasons")
            if (
                not isinstance(reasons, list)
                or not reasons
                or any(not isinstance(reason, str) or reason not in SAMPLING_REASONS for reason in reasons)
                or len(set(reasons)) != len(reasons)
            ):
                errors.append(f"{frame_path}.reasons must contain unique supported sampling reasons")
            if not _positive_integer(frame_candidate.get("width")):
                errors.append(f"{frame_path}.width must be a positive integer")
            if not _positive_integer(frame_candidate.get("height")):
                errors.append(f"{frame_path}.height must be a positive integer")
            artifact = frame_candidate.get("artifact")
            if not _object(artifact):
                errors.append(f"{frame_path}.artifact must be an object")
                continue
            _exact_keys(artifact, ARTIFACT_KEYS, f"{frame_path}.artifact", errors)
            artifact_id = artifact.get("artifact_id")
            if not _identifier(artifact_id):
                errors.append(f"{frame_path}.artifact.artifact_id must be a resource identifier")
            elif artifact_id in artifact_ids:
                errors.append(f"{frame_path}.artifact.artifact_id must be unique")
            if _identifier(artifact_id):
                artifact_ids.add(artifact_id)
            if not _checksum(artifact.get("sha256")):
                errors.append(f"{frame_path}.artifact.sha256 must be a lowercase SHA-256 digest")
            if not _positive_integer(artifact.get("size_bytes")):
                errors.append(f"{frame_path}.artifact.size_bytes must be a positive integer")
            media_type = artifact.get("media_type")
            if not isinstance(media_type, str) or media_type not in FRAME_MEDIA_TYPES:
                errors.append(f"{frame_path}.artifact.media_type is not a supported frame media type")

    if value.get("source_count") != len(sources):
        errors.append("manifest.source_count does not match manifest.sources.length")
    if value.get("frame_count") != counted_frames:
        errors.append("manifest.frame_count does not match the number of frames")
    dataset_source_ids = context.get("datasetSourceIds")
    if dataset_source_ids is not None:
        expected = set(dataset_source_ids)
        if (
            len(expected) != len(dataset_source_ids)
            or len(expected) != len(source_ids)
            or any(source_id not in source_ids for source_id in expected)
        ):
            errors.append("manifest sources do not exactly cover the dataset version sources")
    return ManifestValidationResult(valid=not errors, errors=errors)


def _is_iso_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def frame_extension(media_type: str) -> str:
    """Return the frame file extension used by the hosted template generator."""
    if media_type == "image/png":
        return "png"
    if media_type == "image/webp":
        return "webp"
    return "jpg"


def frame_filename(frame: Mapping[str, Any]) -> str:
    """Derive the stable evidence filename for one manifest frame."""
    return f"{frame['id']}.{frame_extension(frame['artifact']['media_type'])}"


def _frame_evidence_errors(manifest: Mapping[str, Any], frames_dir: Path) -> list[str]:
    """Verify every manifest frame against local evidence bytes and metadata."""
    errors: list[str] = []
    for source_index, source in enumerate(manifest["sources"]):
        for frame_index, frame in enumerate(source["frames"]):
            artifact = frame["artifact"]
            filename = frame_filename(frame)
            frame_path = frames_dir / filename
            if not frame_path.is_file():
                errors.append(f"frame evidence missing: {filename}")
                continue
            size = frame_path.stat().st_size
            if size != artifact["size_bytes"]:
                errors.append(f"frame evidence size mismatch for {filename}: expected {artifact['size_bytes']}, got {size}")
            digest = sha256_hex(frame_path.read_bytes())
            if digest != artifact["sha256"]:
                errors.append(f"frame evidence checksum mismatch for {filename}")
    return errors


def initialize_managed_annotations(
    manifest: Mapping[str, Any],
    policy: Mapping[str, Any],
    manifest_sha256: str,
    frames_dir: Path | None = None,
    *,
    verify_evidence: bool = True,
) -> dict[str, Any]:
    """Return the prediction-blind object-annotations.v1 template.

    Mirrors `initializeManagedTemplate` in `template-registry.ts`. When
    `frames_dir` is supplied, local frame evidence is verified by size and
    SHA-256 before the template is produced.
    """
    validation = validate_managed_manifest(manifest)
    checks = ["manifest_schema", "manifest_checksum", "policy_checksum", "source_membership", "frame_membership"]
    errors = list(validation.errors)
    if not _checksum(manifest_sha256):
        errors.append("manifest_sha256 must be a lowercase SHA-256 digest")
    if not _checksum(policy.get("sha256")):
        errors.append("policy.sha256 must be a lowercase SHA-256 digest")
    for field in ("id", "version"):
        if not isinstance(policy.get(field), str) or not policy[field].strip():
            errors.append(f"policy.{field} must be a non-empty string")
    if not errors and frames_dir is not None and verify_evidence:
        checks.append("private_evidence")
        evidence_errors = _frame_evidence_errors(manifest, frames_dir)
        if evidence_errors:
            errors.extend(evidence_errors)
    if errors:
        raise ManagedManifestError(
            "managed template initialization failed:\n" + "\n".join(f"  - {error}" for error in errors)
        )

    return {
        "schema_version": ANNOTATION_SCHEMA_VERSION,
        "policy_version": policy["version"],
        "provenance": {
            "frame_set_id": manifest["frame_set_id"],
            "dataset_version_id": manifest["dataset_version_id"],
            "manifest_sha256": manifest_sha256,
            "policy_version_id": policy["id"],
            "policy_sha256": policy["sha256"],
            "generator_version": GENERATOR_VERSION,
        },
        "validation": {
            "valid": True,
            "frame_count": manifest["frame_count"],
            "source_count": manifest["source_count"],
            "checks": checks,
        },
        "review": {
            "independent_passes": 0,
            "predictions_reviewed_before_freeze": False,
            "adjudication_status": "not_started",
            "adjudication_log": [],
            "reviewed_frames": [],
            "assisted_review": {
                "reviewed_frames": [],
                "completed_passes": 0,
                "status": "not_started",
            },
        },
        "sources": [
            {
                "source": source["dataset_source_id"],
                "source_sha256": source["source_sha256"],
                "frames": [
                    {
                        "filename": frame_filename(frame),
                        "timestamp_sec": frame["timestamp_seconds"],
                        "frame_id": frame["id"],
                        "width": frame["width"],
                        "height": frame["height"],
                        "artifact": frame["artifact"],
                        "objects": [],
                        "out_of_taxonomy": [],
                    }
                    for frame in source["frames"]
                ],
            }
            for source in manifest["sources"]
        ],
    }


def load_manifest(path: Path) -> dict[str, Any]:
    """Load and parse a managed manifest file, surfacing readable errors."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ManagedManifestError(f"cannot read manifest {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ManagedManifestError(f"manifest is not valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ManagedManifestError(f"manifest must be an object: {path}")
    return payload


def policy_definition_sha256(document: str) -> str:
    """Compute the policy definition checksum used by the hosted registry."""
    return sha256_hex(
        json.dumps(
            {"annotation_schema_version": ANNOTATION_SCHEMA_VERSION, "document": document.strip()},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )
