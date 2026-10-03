/** @type contract @purpose Validate immutable frame-set-manifest.v1 documents before registration. */

export const FRAME_SET_MANIFEST_VERSION = "frame-set-manifest.v1" as const;

export const FRAME_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const SAMPLING_REASONS = ["scene_change", "interval", "final_frame"] as const;

type FrameMediaType = typeof FRAME_MEDIA_TYPES[number];
type SamplingReason = typeof SAMPLING_REASONS[number];

export interface FrameArtifactReference {
  artifact_id: string;
  sha256: string;
  size_bytes: number;
  media_type: FrameMediaType;
}

export interface FrameSetManifestFrame {
  id: string;
  timestamp_seconds: number;
  reasons: SamplingReason[];
  width: number;
  height: number;
  artifact: FrameArtifactReference;
}

export interface FrameSetManifestSource {
  dataset_source_id: string;
  source_sha256: string;
  size_bytes: number;
  duration_seconds: number;
  frames: FrameSetManifestFrame[];
}

export interface FrameSetManifestV1 {
  schema_version: typeof FRAME_SET_MANIFEST_VERSION;
  frame_set_id: string;
  sampling_job_id: string;
  dataset_version_id: string;
  created_at: string;
  engine: {
    name: string;
    version: string;
    configuration_sha256: string;
  };
  source_count: number;
  frame_count: number;
  sources: FrameSetManifestSource[];
}

export interface ManifestValidationContext {
  frameSetId?: string;
  samplingJobId?: string;
  datasetVersionId?: string;
  datasetSourceIds?: readonly string[];
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

type JsonObject = Record<string, unknown>;
const ID = /^[a-z][a-z0-9_]{1,99}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set<string>(FRAME_MEDIA_TYPES);
const REASONS = new Set<string>(SAMPLING_REASONS);

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string, errors: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function checksum(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !SHA256.test(value)) errors.push(`${path} must be a lowercase SHA-256 digest`);
}

function identifier(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !ID.test(value)) errors.push(`${path} must be a resource identifier`);
}

/**
 * Perform structural and semantic validation. Artifact existence, object bytes,
 * and checksums must additionally be verified against R2 during finalization.
 */
export function validateFrameSetManifest(value: unknown, context: ManifestValidationContext = {}): ManifestValidationResult {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ["manifest must be an object"] };
  exactKeys(value, ["schema_version", "frame_set_id", "sampling_job_id", "dataset_version_id", "created_at", "engine", "source_count", "frame_count", "sources"], "manifest", errors);
  if (value.schema_version !== FRAME_SET_MANIFEST_VERSION) errors.push(`manifest.schema_version must equal ${FRAME_SET_MANIFEST_VERSION}`);
  identifier(value.frame_set_id, "manifest.frame_set_id", errors);
  identifier(value.sampling_job_id, "manifest.sampling_job_id", errors);
  identifier(value.dataset_version_id, "manifest.dataset_version_id", errors);
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) errors.push("manifest.created_at must be an ISO-8601 timestamp");
  if (context.frameSetId !== undefined && value.frame_set_id !== context.frameSetId) errors.push("manifest.frame_set_id does not match the finalization request");
  if (context.samplingJobId !== undefined && value.sampling_job_id !== context.samplingJobId) errors.push("manifest.sampling_job_id does not match the leased job");
  if (context.datasetVersionId !== undefined && value.dataset_version_id !== context.datasetVersionId) errors.push("manifest.dataset_version_id does not match the job input");

  if (!object(value.engine)) {
    errors.push("manifest.engine must be an object");
  } else {
    exactKeys(value.engine, ["name", "version", "configuration_sha256"], "manifest.engine", errors);
    if (typeof value.engine.name !== "string" || value.engine.name.length < 1 || value.engine.name.length > 100) errors.push("manifest.engine.name must contain 1-100 characters");
    if (typeof value.engine.version !== "string" || value.engine.version.length < 1 || value.engine.version.length > 100) errors.push("manifest.engine.version must contain 1-100 characters");
    checksum(value.engine.configuration_sha256, "manifest.engine.configuration_sha256", errors);
  }

  if (!positiveInteger(value.source_count)) errors.push("manifest.source_count must be a positive integer");
  if (!positiveInteger(value.frame_count)) errors.push("manifest.frame_count must be a positive integer");
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    errors.push("manifest.sources must be a non-empty array");
    return { valid: errors.length === 0, errors };
  }

  const sourceIds = new Set<string>();
  const frameIds = new Set<string>();
  const artifactIds = new Set<string>();
  let countedFrames = 0;
  for (const [sourceIndex, candidate] of value.sources.entries()) {
    const path = `manifest.sources[${sourceIndex}]`;
    if (!object(candidate)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    exactKeys(candidate, ["dataset_source_id", "source_sha256", "size_bytes", "duration_seconds", "frames"], path, errors);
    identifier(candidate.dataset_source_id, `${path}.dataset_source_id`, errors);
    if (typeof candidate.dataset_source_id === "string") {
      if (sourceIds.has(candidate.dataset_source_id)) errors.push(`${path}.dataset_source_id must be unique`);
      sourceIds.add(candidate.dataset_source_id);
    }
    checksum(candidate.source_sha256, `${path}.source_sha256`, errors);
    if (!positiveInteger(candidate.size_bytes)) errors.push(`${path}.size_bytes must be a positive integer`);
    if (typeof candidate.duration_seconds !== "number" || !Number.isFinite(candidate.duration_seconds) || candidate.duration_seconds <= 0) errors.push(`${path}.duration_seconds must be greater than zero`);
    if (!Array.isArray(candidate.frames) || candidate.frames.length === 0) {
      errors.push(`${path}.frames must be a non-empty array`);
      continue;
    }
    let previousTimestamp = -1;
    for (const [frameIndex, frameCandidate] of candidate.frames.entries()) {
      countedFrames += 1;
      const framePath = `${path}.frames[${frameIndex}]`;
      if (!object(frameCandidate)) {
        errors.push(`${framePath} must be an object`);
        continue;
      }
      exactKeys(frameCandidate, ["id", "timestamp_seconds", "reasons", "width", "height", "artifact"], framePath, errors);
      identifier(frameCandidate.id, `${framePath}.id`, errors);
      if (typeof frameCandidate.id === "string") {
        if (frameIds.has(frameCandidate.id)) errors.push(`${framePath}.id must be globally unique`);
        frameIds.add(frameCandidate.id);
      }
      const timestamp = frameCandidate.timestamp_seconds;
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) errors.push(`${framePath}.timestamp_seconds must be a non-negative number`);
      else {
        if (timestamp < previousTimestamp) errors.push(`${framePath}.timestamp_seconds must be ordered within its source`);
        if (typeof candidate.duration_seconds === "number" && timestamp > candidate.duration_seconds) errors.push(`${framePath}.timestamp_seconds exceeds the source duration`);
        previousTimestamp = timestamp;
      }
      if (!Array.isArray(frameCandidate.reasons) || frameCandidate.reasons.length === 0 || frameCandidate.reasons.some((reason) => typeof reason !== "string" || !REASONS.has(reason)) || new Set(frameCandidate.reasons).size !== frameCandidate.reasons.length) errors.push(`${framePath}.reasons must contain unique supported sampling reasons`);
      if (!positiveInteger(frameCandidate.width)) errors.push(`${framePath}.width must be a positive integer`);
      if (!positiveInteger(frameCandidate.height)) errors.push(`${framePath}.height must be a positive integer`);
      if (!object(frameCandidate.artifact)) {
        errors.push(`${framePath}.artifact must be an object`);
        continue;
      }
      exactKeys(frameCandidate.artifact, ["artifact_id", "sha256", "size_bytes", "media_type"], `${framePath}.artifact`, errors);
      identifier(frameCandidate.artifact.artifact_id, `${framePath}.artifact.artifact_id`, errors);
      if (typeof frameCandidate.artifact.artifact_id === "string") {
        if (artifactIds.has(frameCandidate.artifact.artifact_id)) errors.push(`${framePath}.artifact.artifact_id must be unique`);
        artifactIds.add(frameCandidate.artifact.artifact_id);
      }
      checksum(frameCandidate.artifact.sha256, `${framePath}.artifact.sha256`, errors);
      if (!positiveInteger(frameCandidate.artifact.size_bytes)) errors.push(`${framePath}.artifact.size_bytes must be a positive integer`);
      if (typeof frameCandidate.artifact.media_type !== "string" || !MEDIA_TYPES.has(frameCandidate.artifact.media_type)) errors.push(`${framePath}.artifact.media_type is not a supported frame media type`);
    }
  }

  if (value.source_count !== value.sources.length) errors.push("manifest.source_count does not match manifest.sources.length");
  if (value.frame_count !== countedFrames) errors.push("manifest.frame_count does not match the number of frames");
  if (context.datasetSourceIds !== undefined) {
    const expected = new Set(context.datasetSourceIds);
    if (expected.size !== context.datasetSourceIds.length || expected.size !== sourceIds.size || [...expected].some((sourceId) => !sourceIds.has(sourceId))) errors.push("manifest sources do not exactly cover the dataset version sources");
  }
  return { valid: errors.length === 0, errors };
}
