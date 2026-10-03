/** @type implementation @purpose Stage lease-bound frame artifacts and atomically finalize verified frame sets. */
import { FRAME_MEDIA_TYPES, validateFrameSetManifest, type FrameSetManifestV1 } from "./frame-set-manifest";
import type { AdjudicationEnv } from "./types";

type JsonRecord = Record<string, unknown>;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const MEDIA_TYPES = new Set<string>(FRAME_MEDIA_TYPES);

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (code: string, message: string, status: number, details?: unknown) => json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function jsonBody(request: Request): Promise<JsonRecord | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error("unsupported_media_type", "content-type must be application/json", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) return error("request_too_large", "request body is too large", 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) return error("request_too_large", "request body is too large", 413);
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : error("invalid_request", "request body must be a JSON object", 400);
  } catch {
    return error("invalid_json", "request body is not valid JSON", 400);
  }
}

function exactKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function frameSetId(jobId: string): string {
  return `frameset_${jobId.startsWith("job_") ? jobId.slice(4) : jobId}`;
}

function extension(mediaType: string): string {
  return mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpg";
}

async function activeLease(env: AdjudicationEnv, jobId: string, leaseHash: string): Promise<JsonRecord | null> {
  return env.CONTROL_DB.prepare(`SELECT id, input_json, attempt_count FROM internal_jobs
    WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND lease_token_hash = ?
      AND lease_expires_at > ? AND cancellation_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')`)
    .bind(jobId, leaseHash, now(), leaseHash).first<JsonRecord>();
}

async function reserveArtifact(request: Request, env: AdjudicationEnv, jobId: string, leaseHash: string): Promise<Response> {
  const value = await jsonBody(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["sha256", "size_bytes", "media_type"]) || typeof value.sha256 !== "string" || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.size_bytes) || Number(value.size_bytes) < 1 || Number(value.size_bytes) > MAX_ARTIFACT_BYTES || typeof value.media_type !== "string" || !MEDIA_TYPES.has(value.media_type)) {
    return error("invalid_request", `sha256, size_bytes (1-${MAX_ARTIFACT_BYTES}), and a supported image media_type are required`, 400);
  }
  const artifactId = id("artifact");
  const storageKey = `sampling/${jobId}/frames/${artifactId}.${extension(value.media_type)}`;
  const createdAt = now();
  const row = await env.CONTROL_DB.prepare(`INSERT INTO artifact_uploads (id, sampling_job_id, lease_token_hash, kind, storage_key, sha256, size_bytes, media_type, created_at)
    SELECT ?, id, ?, 'frame_image', ?, ?, ?, ?, ? FROM internal_jobs
    WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
    RETURNING id, storage_key, sha256, size_bytes, media_type, status`)
    .bind(artifactId, leaseHash, storageKey, value.sha256, value.size_bytes, value.media_type, createdAt, jobId, leaseHash, createdAt, leaseHash).first<JsonRecord>();
  if (!row) return error("invalid_lease", "job lease is invalid, expired, or cancellation was requested", 409);
  return json({ data: { ...row, upload_path: `/api/internal/v1/runner/sampling-jobs/${encodeURIComponent(jobId)}/artifacts/${artifactId}` } }, 201);
}

async function uploadArtifact(request: Request, env: AdjudicationEnv, jobId: string, artifactId: string, leaseHash: string): Promise<Response> {
  const reservation = await env.CONTROL_DB.prepare(`SELECT au.* FROM artifact_uploads au JOIN internal_jobs j ON j.id = au.sampling_job_id
    WHERE au.id = ? AND au.sampling_job_id = ? AND au.lease_token_hash = ? AND au.status IN ('reserved', 'uploaded')
      AND j.status = 'running' AND j.lease_token_hash = ? AND j.lease_expires_at > ? AND j.cancellation_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = j.id AND lease_token_hash = ? AND status = 'running')`)
    .bind(artifactId, jobId, leaseHash, leaseHash, now(), leaseHash).first<JsonRecord>();
  if (!reservation) return error("invalid_lease", "artifact reservation or active job lease was not found", 409);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== reservation.media_type) return error("artifact_mismatch", "content-type does not match the reservation", 422);
  const declaredLength = Number(request.headers.get("content-length") ?? -1);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== Number(reservation.size_bytes)) return error("artifact_mismatch", "content-length does not match the reservation", 422);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== Number(reservation.size_bytes) || bytes.byteLength > MAX_ARTIFACT_BYTES) return error("artifact_mismatch", "uploaded byte size does not match the reservation", 422);
  const checksum = await sha256Hex(bytes);
  if (checksum !== reservation.sha256) return error("checksum_mismatch", "uploaded bytes do not match the reserved SHA-256", 422);

  await env.INTERNAL_ARTIFACTS_BUCKET.put(String(reservation.storage_key), bytes, {
    httpMetadata: { contentType },
    customMetadata: { sha256: checksum, artifactId, samplingJobId: jobId },
  });
  const uploadedAt = now();
  const updated = await env.CONTROL_DB.prepare(`UPDATE artifact_uploads SET status = 'uploaded', uploaded_at = COALESCE(uploaded_at, ?)
    WHERE id = ? AND sampling_job_id = ? AND lease_token_hash = ? AND status IN ('reserved', 'uploaded')
      AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL)
    RETURNING id, storage_key, sha256, size_bytes, media_type, status, uploaded_at`)
    .bind(uploadedAt, artifactId, jobId, leaseHash, jobId, leaseHash, uploadedAt).first<JsonRecord>();
  if (!updated) {
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(String(reservation.storage_key));
    return error("invalid_lease", "job lease expired while the artifact was uploaded", 409);
  }
  return json({ data: updated });
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, () => `(${Array(columns).fill("?").join(",")})`).join(",");
}

async function finalize(request: Request, env: AdjudicationEnv, jobId: string, leaseHash: string): Promise<Response> {
  const existing = await env.CONTROL_DB.prepare("SELECT id, manifest_artifact_id, frame_count, source_count, sha256, status FROM frame_sets WHERE sampling_job_id = ? AND finalized_by_lease_hash = ?")
    .bind(jobId, leaseHash).first<JsonRecord>();
  if (existing) return json({ data: existing, meta: { deduplicated: true } });
  const job = await activeLease(env, jobId, leaseHash);
  if (!job) return error("invalid_lease", "job lease is invalid, expired, or cancellation was requested", 409);
  const value = await jsonBody(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["manifest"]) || !value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest)) return error("invalid_request", "manifest must be an object", 400);
  const input = JSON.parse(String(job.input_json)) as JsonRecord;
  const datasetVersionId = String(input.dataset_version_id ?? "");
  const sourceRows = await env.DATASET_DB.prepare("SELECT id FROM dataset_sources WHERE dataset_version_id = ? ORDER BY ordinal").bind(datasetVersionId).all<{ id: string }>();
  const datasetSourceIds = (sourceRows.results ?? []).map((source) => source.id);
  if (datasetSourceIds.length === 0) return error("dataset_unavailable", "dataset version has no registered sources", 409);
  const expectedFrameSetId = frameSetId(jobId);
  const validation = validateFrameSetManifest(value.manifest, { frameSetId: expectedFrameSetId, samplingJobId: jobId, datasetVersionId, datasetSourceIds });
  if (!validation.valid) return error("invalid_manifest", "frame-set manifest validation failed", 422, { errors: validation.errors });
  const manifest = value.manifest as unknown as FrameSetManifestV1;
  const frames = manifest.sources.flatMap((source) => source.frames.map((frame, ordinal) => ({ source, frame, ordinal })));

  const uploads = new Map<string, JsonRecord>();
  for (const { frame } of frames) {
    const upload = await env.CONTROL_DB.prepare("SELECT id, storage_key, sha256, size_bytes, media_type, status FROM artifact_uploads WHERE id = ? AND sampling_job_id = ? AND lease_token_hash = ? AND status = 'uploaded'")
      .bind(frame.artifact.artifact_id, jobId, leaseHash).first<JsonRecord>();
    if (!upload) return error("artifact_not_ready", `artifact ${frame.artifact.artifact_id} is not uploaded for this lease`, 409);
    if (upload.sha256 !== frame.artifact.sha256 || Number(upload.size_bytes) !== frame.artifact.size_bytes || upload.media_type !== frame.artifact.media_type) return error("artifact_mismatch", `artifact ${frame.artifact.artifact_id} does not match its manifest declaration`, 422);
    const object = await env.INTERNAL_ARTIFACTS_BUCKET.head(String(upload.storage_key));
    if (!object || object.size !== frame.artifact.size_bytes || object.customMetadata?.sha256 !== frame.artifact.sha256 || object.httpMetadata?.contentType !== frame.artifact.media_type) return error("artifact_verification_failed", `artifact ${frame.artifact.artifact_id} is missing or its stored metadata does not match`, 422);
    uploads.set(frame.artifact.artifact_id, upload);
  }

  const manifestJson = JSON.stringify(manifest);
  const manifestSha = await sha256Hex(manifestJson);
  const manifestBytes = new TextEncoder().encode(manifestJson);
  const manifestArtifactId = `artifact_manifest_${jobId.startsWith("job_") ? jobId.slice(4) : jobId}`;
  const manifestKey = `sampling/${jobId}/manifests/${manifestSha}.json`;
  await env.INTERNAL_ARTIFACTS_BUCKET.put(manifestKey, manifestBytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: manifestSha, artifactId: manifestArtifactId, samplingJobId: jobId } });

  const timestamp = now();
  const artifactValues = frames.flatMap(({ frame }) => {
    const upload = uploads.get(frame.artifact.artifact_id)!;
    return [frame.artifact.artifact_id, "frame_image", upload.storage_key, frame.artifact.sha256, frame.artifact.size_bytes, frame.artifact.media_type, timestamp];
  });
  const sourceValues = manifest.sources.flatMap((source, ordinal) => [manifest.frame_set_id, source.dataset_source_id, ordinal, source.source_sha256, source.size_bytes, source.duration_seconds]);
  const frameValues = frames.flatMap(({ source, frame, ordinal }) => [frame.id, manifest.frame_set_id, source.dataset_source_id, ordinal, frame.timestamp_seconds, JSON.stringify(frame.reasons), frame.artifact.artifact_id, frame.width, frame.height]);
  const output = JSON.stringify({ frame_set_id: manifest.frame_set_id, manifest_artifact_id: manifestArtifactId, manifest_sha256: manifestSha });
  const statements = [
    env.CONTROL_DB.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES (?, 'frame_manifest', ?, ?, ?, 'application/json', ?)").bind(manifestArtifactId, manifestKey, manifestSha, manifestBytes.byteLength, timestamp),
    env.CONTROL_DB.prepare(`INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES ${placeholders(frames.length, 7)}`).bind(...artifactValues),
    env.CONTROL_DB.prepare(`INSERT INTO frame_sets (id, dataset_version_id, sampling_job_id, manifest_artifact_id, source_count, frame_count, sha256, status, created_at, manifest_schema_version, engine_name, engine_version, engine_configuration_sha256, finalized_by_lease_hash)
      SELECT ?, ?, id, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ? FROM internal_jobs
      WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL`)
      .bind(manifest.frame_set_id, manifest.dataset_version_id, manifestArtifactId, manifest.source_count, manifest.frame_count, manifestSha, timestamp, manifest.schema_version, manifest.engine.name, manifest.engine.version, manifest.engine.configuration_sha256, leaseHash, jobId, leaseHash, timestamp),
    env.CONTROL_DB.prepare(`INSERT INTO frame_set_sources (frame_set_id, dataset_source_id, ordinal, source_sha256, size_bytes, duration_seconds) VALUES ${placeholders(manifest.sources.length, 6)}`).bind(...sourceValues),
    env.CONTROL_DB.prepare(`INSERT INTO frame_set_frames (id, frame_set_id, dataset_source_id, ordinal, timestamp_seconds, reasons_json, artifact_id, width, height) VALUES ${placeholders(frames.length, 9)}`).bind(...frameValues),
    env.CONTROL_DB.prepare(`UPDATE artifact_uploads SET status = 'finalized', finalized_at = ? WHERE sampling_job_id = ? AND lease_token_hash = ? AND status = 'uploaded'`).bind(timestamp, jobId, leaseHash),
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = 'succeeded', output_json = ?, finished_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running'").bind(output, timestamp, jobId, leaseHash),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'succeeded', output_json = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL").bind(output, timestamp, timestamp, jobId, leaseHash, timestamp),
  ];
  try {
    const results = await env.CONTROL_DB.batch(statements);
    if (!results.every((result) => result.success)) throw new Error("frame-set transaction failed");
  } catch (cause) {
    const finalized = await env.CONTROL_DB.prepare("SELECT id, manifest_artifact_id, frame_count, source_count, sha256, status FROM frame_sets WHERE sampling_job_id = ? AND finalized_by_lease_hash = ?")
      .bind(jobId, leaseHash).first<JsonRecord>();
    if (finalized) {
      if (finalized.sha256 !== manifestSha) await env.INTERNAL_ARTIFACTS_BUCKET.delete(manifestKey);
      return json({ data: finalized, meta: { deduplicated: true } });
    }
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(manifestKey);
    throw cause;
  }
  return json({ data: { id: manifest.frame_set_id, manifest_artifact_id: manifestArtifactId, source_count: manifest.source_count, frame_count: manifest.frame_count, sha256: manifestSha, status: "ready" } }, 201);
}

/** Return null when the runner route is not an artifact-pipeline operation. */
export async function handleArtifactPipeline(request: Request, env: AdjudicationEnv, jobId: string, action: string, artifactId?: string): Promise<Response | null> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const leaseHash = await sha256Hex(token);
  if (action === "artifacts" && artifactId === undefined) return request.method === "POST" ? reserveArtifact(request, env, jobId, leaseHash) : error("method_not_allowed", "method not allowed", 405);
  if (action === "artifacts" && artifactId !== undefined) return request.method === "PUT" ? uploadArtifact(request, env, jobId, artifactId, leaseHash) : error("method_not_allowed", "method not allowed", 405);
  if (action === "finalize") return request.method === "POST" ? finalize(request, env, jobId, leaseHash) : error("method_not_allowed", "method not allowed", 405);
  return null;
}

export function expectedFrameSetId(jobId: string): string {
  return frameSetId(jobId);
}
