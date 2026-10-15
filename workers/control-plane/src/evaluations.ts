/** @type implementation @purpose Freeze eligible evaluation inputs and expose durable run records. */
import type { AdjudicationEnv } from "./types";
import type { InternalActor } from "./internal-auth";
import { getEligibleGroundTruth } from "./ground-truth";
import { sha256Hex } from "./artifact-pipeline";
import { evaluationInputArtifact, evaluationInputPlan } from "./job-lifecycle";
import { verifiedArtifact, GovernanceError } from "./release-governance";
import { EVALUATION_IMPLEMENTATION_VERSION } from "./engine-versions";

type Row = Record<string, any>;
const BASE = "/api/internal/v1/evaluations";
const ENGINE_VERSION = EVALUATION_IMPLEMENTATION_VERSION;
const MAX_BODY_BYTES = 16 * 1024;
const resourceId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(value);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
class EvaluationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function fail(message: string, status = 400): never { throw new EvaluationError(message, status); }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestBody(request: Request): Promise<Row> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) fail("request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) fail("request body is too large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request body must be a JSON object");
  return value as Row;
}

function runRow(row: Row) {
  return {
    id: row.id,
    job_id: row.job_id,
    status: row.job_status,
    ground_truth_version_id: row.ground_truth_version_id,
    model_version_id: row.model_version_id,
    pipeline_release_id: row.pipeline_release_id,
    report_artifact_id: row.report_artifact_id,
    input_sha256: row.input_sha256,
    implementation_version: row.implementation_version,
    inputs: JSON.parse(row.configuration_json),
    output: row.output_json ? JSON.parse(row.output_json) : null,
    revision: row.attempt_count,
    error_message: row.error_message,
    attempt_count: Number(row.attempt_count ?? 0),
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

const RUN_SELECT = `SELECT r.*, j.status AS job_status, j.output_json, j.error_message, j.attempt_count,
  j.started_at, j.completed_at
  FROM evaluation_runs r JOIN internal_jobs j ON j.id = r.job_id`;

const comparableMetrics = ["object_precision", "object_recall", "object_f1", "mean_inference_ms", "p95_inference_ms"] as const;
export function compareEvaluationOutputs(baseline: Row, candidate: Row) {
  if (baseline.job_status !== "succeeded" || candidate.job_status !== "succeeded") fail("both evaluation runs must have succeeded", 409);
  let left: Row, right: Row;
  try { left = JSON.parse(String(baseline.output_json)); right = JSON.parse(String(candidate.output_json)); }
  catch { fail("evaluation output is missing or invalid", 422); }
  left = left.metrics ?? left; right = right.metrics ?? right;
  const metrics: Row = {};
  for (const key of comparableMetrics) {
    const a = left[key], b = right[key];
    metrics[key] = typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b)
      ? { baseline: a, candidate: b, delta: Number((b - a).toFixed(6)) }
      : { baseline: a ?? null, candidate: b ?? null, delta: null };
  }
  const sourceIds = [...new Set([...Object.keys(left.sources ?? {}), ...Object.keys(right.sources ?? {})])].sort();
  const sourceMetrics = Object.fromEntries(sourceIds.map((sourceId) => {
    const a = left.sources?.[sourceId] ?? null, b = right.sources?.[sourceId] ?? null;
    return [sourceId, {
      baseline: a ? { true_positives: a.true_positives, false_positives: a.false_positives, false_negatives: a.false_negatives, object_precision: a.object_precision, object_recall: a.object_recall } : null,
      candidate: b ? { true_positives: b.true_positives, false_positives: b.false_positives, false_negatives: b.false_negatives, object_precision: b.object_precision, object_recall: b.object_recall } : null,
    }];
  }));
  return {
    baseline_id: baseline.id, candidate_id: candidate.id,
    baseline_input_sha256: baseline.input_sha256, candidate_input_sha256: candidate.input_sha256,
    baseline_model_version_id: baseline.model_version_id, candidate_model_version_id: candidate.model_version_id,
    same_ground_truth: baseline.ground_truth_version_id === candidate.ground_truth_version_id,
    metrics, source_metrics: sourceMetrics,
  };
}

async function verifyModel(env: AdjudicationEnv, modelVersionId: string) {
  const row = await env.CONTROL_DB.prepare(`SELECT mv.id, mv.model_id, mv.version, mv.artifact_id,
    mv.configuration_json, mv.status, m.task_type, a.storage_key, a.sha256, a.size_bytes, a.media_type
    FROM model_versions mv JOIN models m ON m.id = mv.model_id JOIN artifacts a ON a.id = mv.artifact_id
    WHERE mv.id = ?`).bind(modelVersionId).first<Row>();
  if (!row) fail("model version not found", 404);
  if (!["candidate", "validated", "approved", "production"].includes(row.status)) fail("model version must be an evaluable candidate or approved model", 409);
  if (row.task_type !== "object_detection") fail("managed evaluations currently support object_detection models only", 422);
  if (row.media_type !== "application/octet-stream" && row.media_type !== "application/onnx") fail("model artifact must be a registered ONNX binary", 422);
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(String(row.storage_key));
  if (!stored || stored.size !== Number(row.size_bytes) || stored.customMetadata?.sha256 !== row.sha256) fail("registered model artifact is missing or changed", 422);
  const digest = await sha256Hex(await stored.arrayBuffer());
  if (digest !== row.sha256) fail("registered model artifact checksum does not match", 422);
  return { id: row.id as string, version: row.version as string, artifact_id: row.artifact_id as string, sha256: row.sha256 as string, size_bytes: Number(row.size_bytes), configuration: JSON.parse(row.configuration_json) };
}

async function createRun(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response> {
  const value = await requestBody(request);
  const allowed = ["ground_truth_version_id", "model_version_id", "pipeline_release_id", "configuration", "idempotency_key"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("request contains unknown fields");
  if (!resourceId(value.ground_truth_version_id)) fail("a ground-truth version is required");
  if (!resourceId(value.model_version_id)) fail("an approved model version is required");
  if (value.pipeline_release_id !== undefined && !resourceId(value.pipeline_release_id)) fail("pipeline_release_id is invalid");
  if (value.idempotency_key !== undefined && (typeof value.idempotency_key !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.idempotency_key))) fail("idempotency_key must contain 1-200 safe characters");
  const config = value.configuration ?? {};
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !["minimum_confidence", "nms_threshold", "minimum_iou"].includes(key))) fail("configuration contains unsupported evaluation settings");
  for (const key of ["minimum_confidence", "nms_threshold", "minimum_iou"]) {
    const setting = config[key];
    if (setting !== undefined && (typeof setting !== "number" || !Number.isFinite(setting) || setting < 0 || setting > 1)) fail(`${key} must be between 0 and 1`);
  }
  let eligible;
  try { eligible = await getEligibleGroundTruth(env, value.ground_truth_version_id, "diagnostic"); }
  catch (cause) {
    const status = Number((cause as { status?: unknown })?.status);
    if (Number.isInteger(status) && status >= 400 && status < 600) fail(cause instanceof Error ? cause.message : "ground truth is unavailable", status);
    throw cause;
  }
  if (!eligible.eligible) fail(`ground truth is not eligible: ${eligible.reasons.join("; ")}`, 409);
  const model = await verifyModel(env, value.model_version_id);
  let release: Row | null = null;
  if (value.pipeline_release_id !== undefined) {
    release = await env.CONTROL_DB.prepare("SELECT id, version, configuration_json, status FROM pipeline_releases WHERE id = ?").bind(value.pipeline_release_id).first<Row>();
    if (!release) fail("pipeline release not found", 404);
    if (!["candidate", "approved", "active"].includes(release.status)) fail("pipeline release must be a candidate or approved release", 409);
    let releaseConfig: Row;
    try { releaseConfig = JSON.parse(release.configuration_json); } catch { fail("pipeline release configuration is invalid", 422); }
    if (releaseConfig.model_version_id !== model.id) fail("pipeline release does not pin the selected model version", 409);
    if (Object.entries(releaseConfig.thresholds ?? {}).some(([key, setting]) => (config[key] ?? ({ minimum_confidence: 0.35, nms_threshold: 0.6, minimum_iou: 0.5 } as Row)[key]) !== setting)) fail("evaluation configuration must match release thresholds", 409);
  }
  const pinned = {
    schema_version: "managed-evaluation-inputs.v1",
    ground_truth: eligible,
    model,
    pipeline_release: release ? { id: release.id, version: release.version, configuration_sha256: await sha256Hex(release.configuration_json) } : null,
    configuration: { minimum_confidence: config.minimum_confidence ?? 0.35, nms_threshold: config.nms_threshold ?? 0.6, minimum_iou: config.minimum_iou ?? 0.5 },
    implementation_version: ENGINE_VERSION,
  };
  const inputJson = stable(pinned), inputSha = await sha256Hex(inputJson);
  if (value.idempotency_key) {
    const existing = await env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.idempotency_key = ?`).bind(value.idempotency_key).first<Row>();
    if (existing) {
      if (existing.input_sha256 !== inputSha) fail("idempotency_key is already associated with different evaluation inputs", 409);
      return json({ data: runRow(existing), meta: { deduplicated: true } });
    }
  }
  const runId = `evaluation_${crypto.randomUUID().replaceAll("-", "")}`;
  const jobId = `job_${crypto.randomUUID().replaceAll("-", "")}`;
  const timestamp = new Date().toISOString();
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, created_at, updated_at) VALUES (?, 'evaluation', 'queued', ?, ?, ?)")
        .bind(jobId, inputJson, timestamp, timestamp),
      env.CONTROL_DB.prepare(`INSERT INTO evaluation_runs (id, job_id, ground_truth_version_id, model_version_id,
        pipeline_release_id, configuration_json, created_at, input_sha256, implementation_version, created_by, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(runId, jobId, value.ground_truth_version_id, model.id, release?.id ?? null, inputJson, timestamp, inputSha, ENGINE_VERSION, actor.kind === "user" ? actor.user.id : null, value.idempotency_key ?? null),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'evaluation.created', 'evaluation_run', ?, ?, ?)")
        .bind(actor.kind === "user" ? actor.user.id : null, runId, JSON.stringify({ job_id: jobId, input_sha256: inputSha, ground_truth_version_id: value.ground_truth_version_id, model_version_id: model.id, pipeline_release_id: release?.id ?? null, implementation_version: ENGINE_VERSION }), timestamp),
    ]);
  } catch (cause) {
    if (!value.idempotency_key) throw cause;
    const raced = await env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.idempotency_key = ?`).bind(value.idempotency_key).first<Row>();
    if (!raced) throw cause;
    if (raced.input_sha256 !== inputSha) fail("idempotency_key is already associated with different evaluation inputs", 409);
    return json({ data: runRow(raced), meta: { deduplicated: true } });
  }
  const created = await env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(runId).first<Row>();
  if (!created) fail("evaluation run was not persisted", 500);
  return json({ data: runRow(created), meta: { execution_scheduled: false, runner: "evaluation-runner" } }, 202);
}

export async function handleEvaluations(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
  try {
    if (path === BASE) {
      if (request.method === "POST") return await createRun(request, env, actor);
      if (request.method !== "GET") fail("method not allowed", 405);
      const limitText = url.searchParams.get("limit") ?? "50", offsetText = url.searchParams.get("offset") ?? "0";
      if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText) || Number(limitText) < 1 || Number(limitText) > 100 || !Number.isSafeInteger(Number(offsetText))) fail("invalid pagination");
      const limit = Number(limitText), offset = Number(offsetText);
      const rows = await env.CONTROL_DB.prepare(`${RUN_SELECT} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<Row>();
      return json({ data: (rows.results ?? []).map(runRow), pagination: { limit, offset } });
    }
    if (path === `${BASE}/compare`) {
      if (request.method !== "GET") fail("method not allowed", 405);
      const baselineId = url.searchParams.get("baseline_id"), candidateId = url.searchParams.get("candidate_id");
      if (!resourceId(baselineId) || !resourceId(candidateId) || baselineId === candidateId) fail("baseline_id and a different candidate_id are required");
      const [baseline, candidate] = await Promise.all([
        env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(baselineId).first<Row>(),
        env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(candidateId).first<Row>(),
      ]);
      if (!baseline || !candidate) fail("evaluation run not found", 404);
      const baselineInput = JSON.parse(baseline.configuration_json), candidateInput = JSON.parse(candidate.configuration_json);
      if (baseline.ground_truth_version_id !== candidate.ground_truth_version_id || baselineInput.configuration.minimum_confidence !== candidateInput.configuration.minimum_confidence || baselineInput.configuration.nms_threshold !== candidateInput.configuration.nms_threshold || baselineInput.configuration.minimum_iou !== candidateInput.configuration.minimum_iou) fail("runs must use the same ground truth and thresholds to compare", 409);
      if (baseline.job_status !== "succeeded" || candidate.job_status !== "succeeded") fail("both evaluation runs must have succeeded", 409);
      const reports = await Promise.all([verifiedArtifact(env, baseline.report_artifact_id), verifiedArtifact(env, candidate.report_artifact_id)]);
      baseline.output_json = JSON.stringify(JSON.parse(new TextDecoder().decode(reports[0].bytes)).metrics);
      candidate.output_json = JSON.stringify(JSON.parse(new TextDecoder().decode(reports[1].bytes)).metrics);
      return json({ data: compareEvaluationOutputs(baseline, candidate) });
    }
    const match = path.match(/^\/api\/internal\/v1\/evaluations\/([a-z][a-z0-9_]{1,99})(?:\/(report|inputs)(?:\/artifacts\/([a-z][a-z0-9_]{1,99}))?)?$/);
    if (!match) fail("evaluation route not found", 404);
    if (request.method !== "GET") fail("method not allowed", 405);
    const row = await env.CONTROL_DB.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(match[1]).first<Row>();
    if (!row) fail("evaluation run not found", 404);
    if (match[2] === "inputs") {
      if (match[3]) return evaluationInputArtifact(env, row.job_id, match[3]);
      return evaluationInputPlan(env, { ...row, evaluation_run_id: row.id, input_json: row.configuration_json }, `${BASE}/${row.id}/inputs/artifacts`);
    }
    if (match[2] === "report") {
      if (row.job_status !== "succeeded" || !row.report_artifact_id) fail("evaluation report is not available", 409);
      const artifact = await verifiedArtifact(env, row.report_artifact_id);
      return new Response(artifact.bytes, { headers: { "content-type": "application/json", "cache-control": "no-store", etag: `"${artifact.row.sha256}"` } });
    }
    const attempts = await env.CONTROL_DB.prepare("SELECT attempt_number, status, worker_id, leased_at, finished_at, error_message FROM internal_job_attempts WHERE job_id = ? ORDER BY attempt_number").bind(row.job_id).all();
    return json({ data: { ...runRow(row), attempts: attempts.results } });
  } catch (cause) {
    if (cause instanceof EvaluationError || cause instanceof GovernanceError) return json({ error: { code: "evaluation_request_failed", message: cause.message } }, cause.status);
    console.error({ event: "evaluation_request_failed", error_name: cause instanceof Error ? cause.name : "UnknownError" });
    return json({ error: { code: "internal_error", message: "evaluation request failed" } }, 500);
  }
}
