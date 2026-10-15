/** @type implementation @purpose Coordinate durable sampling-job leases and lifecycle transitions. */
import type { AdjudicationEnv } from "./types";
import { expectedFrameSetId, handleArtifactPipeline } from "./artifact-pipeline";
import { recordIdleRunnerPresence, recordRunnerPresence, runnerAvailabilityAfterJobStatement, RUNNER_PRESENCE_TTL_SECONDS } from "./runner-presence";

type JsonRecord = Record<string, unknown>;
const MAX_BODY_BYTES = 64 * 1024;

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function body(request: Request): Promise<JsonRecord | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error("unsupported_media_type", "content-type must be application/json", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : error("invalid_request", "request body must be a JSON object", 400);
  } catch {
    return error("invalid_json", "request body is not valid JSON", 400);
  }
}

function exactKeys(value: JsonRecord, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function decodeId(value: string): string | Response {
  try {
    const decoded = decodeURIComponent(value);
    return /^[a-zA-Z0-9_-]{1,100}$/.test(decoded) ? decoded : error("invalid_id", "job id is invalid", 400);
  } catch {
    return error("invalid_id", "job id is invalid", 400);
  }
}

function runnerAuthorized(request: Request, env: AdjudicationEnv): boolean {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return Boolean(env.RUNNER_TOKEN && supplied === env.RUNNER_TOKEN);
}

function publicJob(row: JsonRecord) {
  return {
    id: row.id, type: row.job_type, status: row.status,
    input: JSON.parse(String(row.input_json)),
    progress: row.progress_json == null ? null : JSON.parse(String(row.progress_json)),
    output: row.output_json == null ? null : JSON.parse(String(row.output_json)),
    error_message: row.error_message, attempt_count: row.attempt_count,
    max_attempts: row.max_attempts, lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at, heartbeat_at: row.heartbeat_at,
    cancellation_requested_at: row.cancellation_requested_at,
    created_at: row.created_at, started_at: row.started_at,
    completed_at: row.completed_at, updated_at: row.updated_at,
  };
}

function returnedRow(result: D1Result<JsonRecord> | undefined): JsonRecord | null {
  return result?.results?.[0] ?? null;
}

async function sweepExpired(env: AdjudicationEnv, timestamp: string): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = 'lease_expired', finished_at = ?, error_message = 'runner lease expired' WHERE status = 'running' AND lease_expires_at <= ?").bind(timestamp, timestamp),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'cancelled', error_message = 'runner lease expired after cancellation request', cancelled_at = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE job_type IN ('sampling', 'evaluation') AND status = 'running' AND lease_expires_at <= ? AND cancellation_requested_at IS NOT NULL").bind(timestamp, timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'failed', error_message = 'runner lease expired and maximum attempts were exhausted', completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE job_type IN ('sampling', 'evaluation') AND status = 'running' AND lease_expires_at <= ? AND cancellation_requested_at IS NULL AND attempt_count >= max_attempts").bind(timestamp, timestamp, timestamp),
  ]);
}

async function claim(request: Request, env: AdjudicationEnv, jobType: "sampling" | "evaluation" = "sampling"): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["runner_id", "lease_seconds"]) || typeof value.runner_id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.runner_id)) return error("invalid_request", "runner_id must contain 1-100 letters, digits, dots, underscores, or hyphens", 400);
  const leaseSeconds = value.lease_seconds ?? 300;
  if (!Number.isInteger(leaseSeconds) || Number(leaseSeconds) < 30 || Number(leaseSeconds) > 900) return error("invalid_request", "lease_seconds must be an integer from 30 through 900", 400);
  const claimedAt = now(), expiresAt = new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString();
  await sweepExpired(env, claimedAt);
  const runnerId = value.runner_id;
  const leaseToken = `${crypto.randomUUID()}${crypto.randomUUID()}`, leaseHash = await digest(leaseToken);
  const row = await env.CONTROL_DB.prepare(`UPDATE internal_jobs SET status = 'running', lease_owner = ?, lease_token_hash = ?, lease_expires_at = ?, heartbeat_at = ?, attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ?, error_message = NULL
    WHERE id = (SELECT id FROM internal_jobs WHERE job_type = ? AND cancellation_requested_at IS NULL AND attempt_count < max_attempts AND ((status = 'queued' AND (available_at IS NULL OR available_at <= ?)) OR (status = 'running' AND lease_expires_at <= ?)) ORDER BY created_at, id LIMIT 1)
    RETURNING *`).bind(value.runner_id, leaseHash, expiresAt, claimedAt, claimedAt, claimedAt, jobType, claimedAt, claimedAt).first<JsonRecord>();
  if (!row) {
    await recordIdleRunnerPresence(env, runnerId, claimedAt);
    return json({ data: null });
  }
  const attemptId = id("attempt");
  try {
    await env.CONTROL_DB.prepare("INSERT INTO internal_job_attempts (id, job_id, attempt_number, status, worker_id, lease_token_hash, leased_at, lease_expires_at, heartbeat_at, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)")
      .bind(attemptId, row.id, row.attempt_count, value.runner_id, leaseHash, claimedAt, expiresAt, claimedAt, claimedAt).run();
  } catch (cause) {
    await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'queued', attempt_count = attempt_count - 1, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token_hash = ?")
      .bind(now(), row.id, leaseHash).run();
    throw cause;
  }
  await recordRunnerPresence(env, runnerId, "busy", String(row.id), claimedAt);
  return json({ data: { job: publicJob(row), attempt_id: attemptId, lease_token: leaseToken, lease_expires_at: expiresAt, ...(jobType === "sampling" ? { frame_set_id: expectedFrameSetId(String(row.id)) } : {}) } });
}

async function datasetSources(env: AdjudicationEnv, datasetVersionId: string): Promise<Response> {
  const version = await env.DATASET_DB.prepare("SELECT id, status FROM dataset_versions WHERE id = ?")
    .bind(datasetVersionId).first<{ id: string; status: string }>();
  if (!version) return error("not_found", "dataset version not found", 404);
  if (version.status !== "frozen" && version.status !== "ready") return error("invalid_state", "dataset version is not available for sampling", 409);
  const rows = await env.DATASET_DB.prepare("SELECT id, source_url AS url, display_name, ordinal FROM dataset_sources WHERE dataset_version_id = ? ORDER BY ordinal")
    .bind(datasetVersionId).all<JsonRecord>();
  const sources = rows.results ?? [];
  if (!sources.length) return error("dataset_unavailable", "dataset version has no registered sources", 409);
  return json({ data: { dataset_version_id: datasetVersionId, sources } });
}

async function evaluationLease(request: Request, env: AdjudicationEnv, jobId: string): Promise<JsonRecord | Response> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const hash = await digest(token), timestamp = now();
  const row = await env.CONTROL_DB.prepare(`SELECT j.id AS job_id, j.input_json, j.lease_token_hash, j.lease_expires_at, r.id AS evaluation_run_id,
      r.input_sha256, r.implementation_version, r.ground_truth_version_id, r.model_version_id
    FROM internal_jobs j JOIN evaluation_runs r ON r.job_id = j.id
    WHERE j.id = ? AND j.job_type = 'evaluation' AND j.status = 'running' AND j.cancellation_requested_at IS NULL AND j.lease_token_hash = ? AND j.lease_expires_at > ?`)
    .bind(jobId, hash, timestamp).first<JsonRecord>();
  return row ?? error("invalid_lease", "evaluation job lease is invalid or expired", 409);
}

async function evaluationInputs(request: Request, env: AdjudicationEnv, jobId: string): Promise<Response> {
  const lease = await evaluationLease(request, env, jobId);
  if (lease instanceof Response) return lease;
  return evaluationInputPlan(env, lease, `/api/internal/v1/runner/evaluation-jobs/${jobId}/artifacts`, true);
}

export async function evaluationInputPlan(env: AdjudicationEnv, lease: JsonRecord, artifactBase: string, requireCurrent = false): Promise<Response> {
  const jobId = String(lease.job_id);
  let pinned: JsonRecord;
  try { pinned = JSON.parse(String(lease.input_json)); } catch { return error("evaluation_input_invalid", "stored evaluation inputs are invalid", 500); }
  const pinnedModel = pinned.model as JsonRecord | undefined;
  const pinnedTruth = pinned.ground_truth as JsonRecord | undefined;
  const pinnedCandidate = pinnedTruth?.candidate_artifact as JsonRecord | undefined;
  const [model, truth, frames] = await Promise.all([
    env.CONTROL_DB.prepare(`SELECT a.id, a.sha256, a.size_bytes, a.media_type FROM model_versions mv JOIN artifacts a ON a.id = mv.artifact_id WHERE mv.id = ?${requireCurrent ? " AND mv.status IN ('candidate','validated','approved','production')" : ""}`)
      .bind(lease.model_version_id).first<JsonRecord>(),
    env.CONTROL_DB.prepare(`SELECT a.id, a.sha256, a.size_bytes, a.media_type FROM ground_truth_versions g JOIN artifacts a ON a.id = g.artifact_id WHERE g.id = ?${requireCurrent ? " AND g.status = 'approved' AND g.approval_status = 'approved' AND g.approval_scope = 'diagnostic'" : ""}`)
      .bind(lease.ground_truth_version_id).first<JsonRecord>(),
    env.CONTROL_DB.prepare(`SELECT f.dataset_source_id AS source_id, f.id AS frame_id, f.timestamp_seconds, f.width, f.height, a.id AS artifact_id, a.sha256, a.size_bytes, a.media_type
      FROM evaluation_runs r JOIN ground_truth_versions g ON g.id = r.ground_truth_version_id
      JOIN review_campaigns c ON c.id = g.campaign_id JOIN templates t ON t.id = c.template_id
      JOIN frame_set_frames f ON f.frame_set_id = t.frame_set_id JOIN artifacts a ON a.id = f.artifact_id
      WHERE r.job_id = ? ORDER BY f.dataset_source_id, f.ordinal`).bind(jobId).all<JsonRecord>(),
  ]);
  if (!model || !truth || !frames.results?.length || frames.results.length > 500) return error("evaluation_inputs_unavailable", "registered model, approved ground truth, or frame evidence is unavailable", 422);
  if (model.sha256 !== pinnedModel?.sha256 || truth.id !== pinnedCandidate?.id || truth.sha256 !== pinnedCandidate?.sha256) return error("evaluation_inputs_changed", "registered evaluation inputs differ from their frozen manifest", 422);
  return json({ data: {
    evaluation_run_id: lease.evaluation_run_id,
    input_sha256: lease.input_sha256,
    implementation_version: lease.implementation_version,
    configuration: pinned.configuration,
    model: { ...model, download_path: `${artifactBase}/${model.id}` },
    ground_truth: { ...truth, download_path: `${artifactBase}/${truth.id}` },
    frames: frames.results.map((frame) => ({ ...frame, download_path: `${artifactBase}/${frame.artifact_id}` })),
  } });
}

async function evaluationArtifact(request: Request, env: AdjudicationEnv, jobId: string, artifactId: string): Promise<Response> {
  const lease = await evaluationLease(request, env, jobId);
  if (lease instanceof Response) return lease;
  return evaluationInputArtifact(env, jobId, artifactId);
}

export async function evaluationInputArtifact(env: AdjudicationEnv, jobId: string, artifactId: string): Promise<Response> {
  const artifact = await env.CONTROL_DB.prepare(`SELECT a.storage_key, a.sha256, a.size_bytes, a.media_type FROM artifacts a
    WHERE a.id = ? AND (
      EXISTS (SELECT 1 FROM evaluation_runs r JOIN model_versions mv ON mv.id = r.model_version_id WHERE r.job_id = ? AND mv.artifact_id = a.id)
      OR EXISTS (SELECT 1 FROM evaluation_runs r JOIN ground_truth_versions g ON g.id = r.ground_truth_version_id WHERE r.job_id = ? AND g.artifact_id = a.id)
      OR EXISTS (SELECT 1 FROM evaluation_runs r JOIN ground_truth_versions g ON g.id = r.ground_truth_version_id JOIN review_campaigns c ON c.id = g.campaign_id JOIN templates t ON t.id = c.template_id JOIN frame_set_frames f ON f.frame_set_id = t.frame_set_id WHERE r.job_id = ? AND f.artifact_id = a.id)
    )`).bind(artifactId, jobId, jobId, jobId).first<JsonRecord>();
  if (!artifact) return error("not_found", "artifact is not an input to this evaluation run", 404);
  const object = await env.INTERNAL_ARTIFACTS_BUCKET.get(String(artifact.storage_key));
  if (!object || object.size !== Number(artifact.size_bytes) || object.customMetadata?.sha256 !== artifact.sha256) return error("artifact_unavailable", "registered evaluation input is missing or changed", 422);
  const bytes = await object.arrayBuffer();
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (checksum !== artifact.sha256) return error("artifact_unavailable", "registered evaluation input checksum mismatch", 422);
  return new Response(bytes, { headers: { "content-type": String(artifact.media_type), "content-length": String(artifact.size_bytes), "cache-control": "no-store", etag: `"${artifact.sha256}"` } });
}

async function heartbeat(request: Request, env: AdjudicationEnv, jobId: string, jobType: "sampling" | "evaluation" = "sampling"): Promise<Response> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["lease_seconds", "progress"])) return error("invalid_request", "request contains unknown fields", 400);
  const leaseSeconds = value.lease_seconds ?? 300;
  if (!Number.isInteger(leaseSeconds) || Number(leaseSeconds) < 30 || Number(leaseSeconds) > 900) return error("invalid_request", "lease_seconds must be an integer from 30 through 900", 400);
  if (value.progress !== undefined && (!value.progress || typeof value.progress !== "object" || Array.isArray(value.progress))) return error("invalid_request", "progress must be an object", 400);
  const hash = await digest(token), timestamp = now(), expiresAt = new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString();
  const results = await env.CONTROL_DB.batch<JsonRecord>([
    env.CONTROL_DB.prepare(`UPDATE internal_jobs SET heartbeat_at = ?, lease_expires_at = ?, progress_json = COALESCE(?, progress_json), updated_at = ?
      WHERE id = ? AND job_type = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
      RETURNING cancellation_requested_at`).bind(timestamp, expiresAt, value.progress === undefined ? null : JSON.stringify(value.progress), timestamp, jobId, jobType, hash, timestamp, hash),
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET heartbeat_at = ?, lease_expires_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running' AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND heartbeat_at = ? AND lease_expires_at = ?)").bind(timestamp, expiresAt, jobId, hash, jobId, hash, timestamp, expiresAt),
    env.CONTROL_DB.prepare(`UPDATE runner_presence SET last_seen_at = ?, expires_at = ?
      WHERE current_job_id = ? AND status = 'busy' AND runner_id = (SELECT lease_owner FROM internal_jobs WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at = ?)`)
      .bind(timestamp, new Date(Date.parse(timestamp) + RUNNER_PRESENCE_TTL_SECONDS * 1000).toISOString(), jobId, jobId, hash, expiresAt),
  ]);
  const row = returnedRow(results[0]);
  if (!row) return error("invalid_lease", "job lease is invalid or expired", 409);
  return json({ data: { id: jobId, lease_expires_at: expiresAt, cancellation_requested: Boolean(row.cancellation_requested_at) } });
}

async function completeEvaluation(request: Request, env: AdjudicationEnv, jobId: string, leaseHash: string, timestamp: string): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 8 * 1024 * 1024) return error("request_too_large", "evaluation report exceeds 8 MiB", 413);
  let text: string;
  try { text = await request.text(); } catch { return error("invalid_request", "evaluation report could not be read", 400); }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > 8 * 1024 * 1024) return error("request_too_large", "evaluation report exceeds 8 MiB", 413);
  let report: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return error("invalid_report", "evaluation report must be a JSON object", 400);
    report = parsed as JsonRecord;
  } catch { return error("invalid_report", "evaluation report must be valid JSON", 400); }
  if (report.schema_version !== "managed-evaluation-report.v1" || typeof report.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.input_sha256) || typeof report.implementation_version !== "string" || !report.metrics || typeof report.metrics !== "object" || Array.isArray(report.metrics)) return error("invalid_report", "evaluation report is missing its schema, input checksum, implementation version, or metrics", 400);
  const metrics = report.metrics as JsonRecord;
  for (const key of ["object_precision", "object_recall", "object_f1"]) {
    const metric = metrics[key];
    if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || metric > 1)) return error("invalid_metrics", `${key} must be null or a finite value between 0 and 1`, 422);
  }
  for (const key of ["mean_inference_ms", "p95_inference_ms"]) {
    const metric = metrics[key];
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) return error("invalid_metrics", `${key} must be finite and non-negative`, 422);
  }

  const run = await env.CONTROL_DB.prepare(`SELECT r.id, r.input_sha256, r.implementation_version, r.ground_truth_version_id, r.model_version_id, j.input_json FROM evaluation_runs r
    JOIN internal_jobs j ON j.id = r.job_id WHERE r.job_id = ? AND j.job_type = 'evaluation'`).bind(jobId).first<JsonRecord>();
  if (!run) return error("evaluation_run_not_found", "evaluation run was not found", 404);
  if (run.input_sha256 !== report.input_sha256 || run.implementation_version !== report.implementation_version) return error("evaluation_input_mismatch", "report does not match the frozen evaluation inputs and implementation", 422);
  let pinned: JsonRecord;
  try { pinned = JSON.parse(String(run.input_json)); } catch { return error("evaluation_input_invalid", "stored evaluation inputs are invalid", 500); }
  const pinnedModel = pinned.model as JsonRecord | undefined;
  const pinnedTruth = pinned.ground_truth as JsonRecord | undefined;
  const pinnedCandidate = pinnedTruth?.candidate_artifact as JsonRecord | undefined;
  if (report.evaluation_run_id !== run.id || report.model_sha256 !== pinnedModel?.sha256 || report.ground_truth_sha256 !== pinnedCandidate?.sha256) return error("evaluation_model_mismatch", "report identity or input checksums differ from the frozen run", 422);
  const expectedFrames = await env.CONTROL_DB.prepare(`SELECT f.dataset_source_id AS source_id, f.id AS frame_id, a.sha256
    FROM ground_truth_versions g JOIN review_campaigns c ON c.id = g.campaign_id JOIN templates t ON t.id = c.template_id
    JOIN frame_set_frames f ON f.frame_set_id = t.frame_set_id JOIN artifacts a ON a.id = f.artifact_id
    WHERE g.id = ? ORDER BY f.dataset_source_id, f.ordinal`).bind(run.ground_truth_version_id).all<JsonRecord>();
  const reportSources = metrics.sources;
  if (!expectedFrames.results?.length || !reportSources || typeof reportSources !== "object" || Array.isArray(reportSources)) return error("evaluation_coverage_invalid", "report does not contain the registered source and frame slices", 422);
  const reportedChecksums = new Map<string, unknown>();
  const totals = { true_positives: 0, false_positives: 0, false_negatives: 0 };
  for (const [sourceId, sourceValue] of Object.entries(reportSources as JsonRecord)) {
    if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue) || !Array.isArray((sourceValue as JsonRecord).frames)) return error("evaluation_coverage_invalid", "report source slices are malformed", 422);
    for (const frameValue of (sourceValue as JsonRecord).frames as unknown[]) {
      if (!frameValue || typeof frameValue !== "object" || Array.isArray(frameValue)) return error("evaluation_coverage_invalid", "report frame slice is malformed", 422);
      const frame = frameValue as JsonRecord, key = `${sourceId}/${String(frame.frame_id)}`;
      if (reportedChecksums.has(key)) return error("evaluation_coverage_invalid", "report repeats a frame", 422);
      reportedChecksums.set(key, frame.artifact_sha256);
      const score = frame.score as JsonRecord | undefined;
      if (!score || typeof frame.inference_ms !== "number" || !Number.isFinite(frame.inference_ms) || frame.inference_ms < 0) return error("invalid_metrics", "every frame needs finite inference timing and object counts", 422);
      for (const field of ["true_positives", "false_positives", "false_negatives"] as const) {
        if (!Number.isSafeInteger(score[field]) || Number(score[field]) < 0) return error("invalid_metrics", "per-frame object counts must be non-negative safe integers", 422);
        totals[field] += Number(score[field]);
      }
    }
  }
  if (reportedChecksums.size !== expectedFrames.results.length || expectedFrames.results.some((frame) => reportedChecksums.get(`${frame.source_id}/${frame.frame_id}`) !== frame.sha256) || metrics.frame_count !== expectedFrames.results.length) return error("evaluation_coverage_invalid", "report frame coverage or checksums differ from the registered evidence", 422);
  if (metrics.source_count !== Object.keys(reportSources as JsonRecord).length || Object.entries(totals).some(([key, count]) => metrics[key] !== count)) return error("invalid_metrics", "aggregate counts differ from the frame slices", 422);
  const tp = totals.true_positives, fp = totals.false_positives, fn = totals.false_negatives;
  const expectedMetrics = { object_precision: tp + fp ? tp / (tp + fp) : null, object_recall: tp + fn ? tp / (tp + fn) : null, object_f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null };
  if (Object.entries(expectedMetrics).some(([key, value]) => value === null ? metrics[key] !== null : typeof metrics[key] !== "number" || Math.abs(Number(metrics[key]) - value) > 0.000051)) return error("invalid_metrics", "aggregate scores differ from the object counts", 422);

  const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const checksum = [...new Uint8Array(digestBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const artifactId = id("artifact_eval"), storageKey = `evaluations/${run.id}/${artifactId}/${checksum}.json`;
  const summary = Object.fromEntries(["frame_count", "source_count", "true_positives", "false_positives", "false_negatives", "object_precision", "object_recall", "object_f1", "mean_inference_ms", "p95_inference_ms"].filter((key) => metrics[key] !== undefined).map((key) => [key, metrics[key]]));
  await env.INTERNAL_ARTIFACTS_BUCKET.put(storageKey, bytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: checksum, evaluationRunId: String(run.id) } });
  const output = JSON.stringify({ evaluation_run_id: run.id, report_artifact_id: artifactId, report_sha256: checksum, metrics: summary });
  let results: D1Result<JsonRecord>[];
  try {
    results = await env.CONTROL_DB.batch<JsonRecord>([
      env.CONTROL_DB.prepare(`INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at)
        SELECT ?, 'evaluation_report', ?, ?, ?, 'application/json', ? WHERE EXISTS (
          SELECT 1 FROM internal_jobs WHERE id = ? AND job_type = 'evaluation' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL
        )`).bind(artifactId, storageKey, checksum, bytes.byteLength, timestamp, jobId, leaseHash, timestamp),
      env.CONTROL_DB.prepare(`UPDATE evaluation_runs SET report_artifact_id = ? WHERE job_id = ? AND input_sha256 = ? AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND sha256 = ?)`)
        .bind(artifactId, jobId, run.input_sha256, artifactId, checksum),
      env.CONTROL_DB.prepare(`UPDATE internal_jobs SET status = 'succeeded', output_json = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL
        WHERE id = ? AND job_type = 'evaluation' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL
        RETURNING id`).bind(output, timestamp, timestamp, jobId, leaseHash, timestamp),
      env.CONTROL_DB.prepare(`UPDATE internal_job_attempts SET status = 'succeeded', output_json = ?, finished_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running'
        AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'succeeded' AND output_json = ?)`)
        .bind(output, timestamp, jobId, leaseHash, jobId, output),
      runnerAvailabilityAfterJobStatement(env, jobId, timestamp),
      env.CONTROL_DB.prepare(`INSERT INTO internal_audit_events (action, resource_type, resource_id, details_json, created_at)
        SELECT 'evaluation.completed', 'evaluation_run', ?, ?, ? WHERE EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'succeeded' AND output_json = ?)`)
        .bind(run.id, JSON.stringify({ report_artifact_id: artifactId, sha256: checksum }), timestamp, jobId, output),
    ]);
  } catch (cause) {
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey);
    throw cause;
  }
  if (!results[2]?.results?.length) {
    await env.CONTROL_DB.prepare("DELETE FROM artifacts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM evaluation_runs WHERE report_artifact_id = ?)").bind(artifactId, artifactId).run();
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey);
    return error("invalid_lease", "evaluation job lease is invalid, expired, or cancelled", 409);
  }
  return json({ data: { id: jobId, status: "succeeded", evaluation_run_id: run.id, report_artifact_id: artifactId, report_sha256: checksum } });
}

async function finish(request: Request, env: AdjudicationEnv, jobId: string, action: "complete" | "fail", jobType: "sampling" | "evaluation" = "sampling"): Promise<Response> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const hash = await digest(token), timestamp = now();
  if (action === "complete" && jobType === "evaluation") return completeEvaluation(request, env, jobId, hash, timestamp);
  const value = await body(request);
  if (value instanceof Response) return value;
  if (action === "complete") {
    return error("frame_set_required", "sampling jobs succeed only through verified frame-set finalization", 409);
  }
  if (!exactKeys(value, ["error_message", "requeue"]) || typeof value.error_message !== "string" || value.error_message.trim().length < 1 || value.error_message.length > 2000 || (value.requeue !== undefined && typeof value.requeue !== "boolean")) return error("invalid_request", "error_message is required and requeue must be boolean", 400);
  const results = await env.CONTROL_DB.batch<JsonRecord>([
    env.CONTROL_DB.prepare(`UPDATE internal_jobs SET
        status = CASE WHEN cancellation_requested_at IS NOT NULL THEN 'cancelled' WHEN ? = 1 AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
        error_message = ?, completed_at = CASE WHEN cancellation_requested_at IS NULL AND ? = 1 AND attempt_count < max_attempts THEN NULL ELSE ? END,
        cancelled_at = CASE WHEN cancellation_requested_at IS NOT NULL THEN ? ELSE NULL END, updated_at = ?
      WHERE id = ? AND job_type = ? AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
      RETURNING status`).bind(value.requeue === true ? 1 : 0, value.error_message.trim(), value.requeue === true ? 1 : 0, timestamp, timestamp, timestamp, jobId, jobType, hash, timestamp, hash),
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = CASE WHEN EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'cancelled' AND lease_token_hash = ?) THEN 'cancelled' ELSE 'failed' END, error_message = ?, finished_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running' AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status IN ('queued', 'failed', 'cancelled') AND lease_token_hash = ?)").bind(jobId, hash, value.error_message.trim(), timestamp, jobId, hash, jobId, hash),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token_hash = ? AND status IN ('queued', 'failed', 'cancelled')").bind(jobId, hash),
    runnerAvailabilityAfterJobStatement(env, jobId, timestamp),
  ]);
  const row = returnedRow(results[0]);
  if (!row) return error("invalid_lease", "job lease is invalid or expired", 409);
  return json({ data: { id: jobId, status: row.status, requeued: row.status === "queued" } });
}

export async function handleRunnerApi(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/internal/v1/runner/")) return null;
  if (!env.RUNNER_TOKEN) return error("runner_unavailable", "runner authentication is not configured", 503);
  if (!runnerAuthorized(request, env)) return error("unauthorized", "runner bearer token required", 401);
  if (path === "/api/internal/v1/runner/sampling-jobs/claim") return request.method === "POST" ? claim(request, env) : error("method_not_allowed", "method not allowed", 405);
  if (path === "/api/internal/v1/runner/evaluation-jobs/claim") return request.method === "POST" ? claim(request, env, "evaluation") : error("method_not_allowed", "method not allowed", 405);
  const sourcesMatch = path.match(/^\/api\/internal\/v1\/runner\/dataset-versions\/([^/]+)\/sources$/);
  if (sourcesMatch) {
    const datasetVersionId = decodeId(sourcesMatch[1]);
    if (datasetVersionId instanceof Response) return datasetVersionId;
    return request.method === "GET" ? datasetSources(env, datasetVersionId) : error("method_not_allowed", "method not allowed", 405);
  }
  const artifactMatch = path.match(/^\/api\/internal\/v1\/runner\/sampling-jobs\/([^/]+)\/(artifacts|finalize)(?:\/([^/]+))?$/);
  if (artifactMatch) {
    const jobId = decodeId(artifactMatch[1]);
    if (jobId instanceof Response) return jobId;
    const artifactId = artifactMatch[3] === undefined ? undefined : decodeId(artifactMatch[3]);
    if (artifactId instanceof Response) return artifactId;
    return handleArtifactPipeline(request, env, jobId, artifactMatch[2], artifactId);
  }
  const evaluationInputsMatch = path.match(/^\/api\/internal\/v1\/runner\/evaluation-jobs\/([^/]+)\/inputs$/);
  const evaluationArtifactMatch = path.match(/^\/api\/internal\/v1\/runner\/evaluation-jobs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (evaluationInputsMatch || evaluationArtifactMatch) {
    if (request.method !== "GET") return error("method_not_allowed", "method not allowed", 405);
    const jobId = decodeId((evaluationInputsMatch ?? evaluationArtifactMatch)![1]);
    if (jobId instanceof Response) return jobId;
    if (evaluationInputsMatch) return evaluationInputs(request, env, jobId);
    const artifactId = decodeId(evaluationArtifactMatch![2]);
    if (artifactId instanceof Response) return artifactId;
    return evaluationArtifact(request, env, jobId, artifactId);
  }
  const match = path.match(/^\/api\/internal\/v1\/runner\/sampling-jobs\/([^/]+)\/(heartbeat|complete|fail)$/);
  const evaluationMatch = path.match(/^\/api\/internal\/v1\/runner\/evaluation-jobs\/([^/]+)\/(heartbeat|complete|fail)$/);
  if (!match && !evaluationMatch) return null;
  if (request.method !== "POST") return error("method_not_allowed", "method not allowed", 405);
  const activeMatch = match ?? evaluationMatch!;
  const jobType = evaluationMatch ? "evaluation" : "sampling";
  const jobId = decodeId(activeMatch[1]);
  if (jobId instanceof Response) return jobId;
  if (activeMatch[2] === "heartbeat") return heartbeat(request, env, jobId, jobType);
  return finish(request, env, jobId, activeMatch[2] as "complete" | "fail", jobType);
}

async function currentJob(env: AdjudicationEnv, jobId: string, jobType: string): Promise<JsonRecord | null> {
  return env.CONTROL_DB.prepare("SELECT * FROM internal_jobs WHERE id = ? AND job_type = ?").bind(jobId, jobType).first<JsonRecord>();
}

export async function handleAdminJobAction(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const match = path.match(/^\/api\/internal\/v1\/(sampling-jobs|evaluations)\/([^/]+)\/(cancel|retry)$/);
  if (!match) return null;
  if (request.method !== "POST") return error("method_not_allowed", "method not allowed", 405);
  const jobId = decodeId(match[2]);
  if (jobId instanceof Response) return jobId;
  const timestamp = now();
  const jobType = match[1] === "evaluations" ? "evaluation" : "sampling";
  const evaluation = jobType === "evaluation" ? await env.CONTROL_DB.prepare("SELECT job_id FROM evaluation_runs WHERE id = ?").bind(jobId).first<{ job_id: string }>() : null;
  if (jobType === "evaluation" && !evaluation) return error("not_found", "evaluation run not found", 404);
  const activeJobId = evaluation?.job_id ?? jobId;
  if (match[3] === "cancel") {
    const queued = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'cancelled', cancellation_requested_at = ?, cancellation_reason = 'administrator request', cancelled_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND job_type = ? AND status = 'queued' RETURNING id")
      .bind(timestamp, timestamp, timestamp, timestamp, activeJobId, jobType).first<JsonRecord>();
    if (queued) return json({ data: { id: jobId, status: "cancelled", cancellation_requested: false } });
    const running = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET cancellation_requested_at = ?, cancellation_reason = 'administrator request', updated_at = ? WHERE id = ? AND job_type = ? AND status = 'running' AND cancellation_requested_at IS NULL RETURNING id")
      .bind(timestamp, timestamp, activeJobId, jobType).first<JsonRecord>();
    if (running) return json({ data: { id: jobId, status: "running", cancellation_requested: true } });
    const row = await currentJob(env, activeJobId, jobType);
    if (!row) return error("not_found", "sampling job not found", 404);
    if (row.status === "cancelled") return json({ data: { id: jobId, status: "cancelled", cancellation_requested: false } });
    if (row.status === "running" && row.cancellation_requested_at) return json({ data: { id: jobId, status: "running", cancellation_requested: true } });
    return error("invalid_state", "only queued or running jobs can be cancelled", 409);
  }
  const retried = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'queued', available_at = NULL, cancellation_requested_at = NULL, cancellation_reason = NULL, cancelled_at = NULL, completed_at = NULL, error_message = NULL, output_json = NULL, retry_requested_at = ?, max_attempts = CASE WHEN max_attempts <= attempt_count THEN attempt_count + 1 ELSE max_attempts END, updated_at = ? WHERE id = ? AND job_type = ? AND status IN ('failed', 'cancelled') RETURNING id")
    .bind(timestamp, timestamp, activeJobId, jobType).first<JsonRecord>();
  if (retried) return json({ data: { id: jobId, status: "queued" } });
  const row = await currentJob(env, activeJobId, jobType);
  return row ? error("invalid_state", "only failed or cancelled jobs can be retried", 409) : error("not_found", "sampling job not found", 404);
}
