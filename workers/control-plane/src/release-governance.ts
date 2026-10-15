/** @type implementation @purpose Register immutable models and govern evidence-backed release transitions. */
import type { AdjudicationEnv } from "./types";
import type { InternalActor } from "./internal-auth";
import { sha256Hex } from "./artifact-pipeline";
import { getEligibleGroundTruth } from "./ground-truth";
import { EVALUATION_IMPLEMENTATION_VERSION, SAMPLING_IMPLEMENTATION_VERSION } from "./engine-versions";

type Row = Record<string, any>;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
export class GovernanceError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const fail = (message: string, status = 400): never => { throw new GovernanceError(message, status); };
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(value);
function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${name} must contain 1-${max} characters`);
  return (value as string).trim();
}
function record(value: unknown, name: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Row;
}
function keys(value: Row, allowed: string[]) { if (Object.keys(value).some((key) => !allowed.includes(key))) fail("request contains unknown fields"); }
async function body(request: Request, max = 64 * 1024): Promise<Row> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") fail("content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > max) fail("request too large", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > max) fail("request too large", 413);
  try { return record(JSON.parse(raw), "request"); } catch (cause) { if (cause instanceof GovernanceError) throw cause; return fail("invalid JSON"); }
}
function audit(env: AdjudicationEnv, actor: InternalActor, action: string, type: string, resourceId: string, details: Row, timestamp: string) {
  return env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(actor.kind === "user" ? actor.user.id : null, action, type, resourceId, JSON.stringify(details), timestamp);
}
function revision(request: Request, row: Row) {
  if (!request.headers.has("if-match")) fail("If-Match revision is required", 428);
  if (request.headers.get("if-match") !== String(row.revision)) fail("resource changed; reload before deciding", 412);
}
export async function verifiedArtifact(env: AdjudicationEnv, artifactId: string): Promise<{ row: Row; bytes: ArrayBuffer }> {
  const row = await env.CONTROL_DB.prepare("SELECT * FROM artifacts WHERE id = ?").bind(artifactId).first<Row>();
  if (!row) fail("artifact not found", 404);
  const object = await env.INTERNAL_ARTIFACTS_BUCKET.get(row!.storage_key);
  if (!object || object.size !== Number(row!.size_bytes)) fail("artifact is missing or has changed", 422);
  const bytes = await object!.arrayBuffer();
  if (await sha256Hex(bytes) !== row!.sha256) fail("artifact checksum mismatch", 422);
  return { row: row!, bytes };
}
async function evidence(env: AdjudicationEnv, runId: unknown, modelId: string, release?: Row, enforceAcceptance = true): Promise<Row> {
  if (!safeId(runId)) fail("evaluation_run_id is required");
  const run = await env.CONTROL_DB.prepare(`SELECT r.*, j.status FROM evaluation_runs r JOIN internal_jobs j ON j.id = r.job_id WHERE r.id = ?`)
    .bind(runId).first<Row>();
  if (!run || run.status !== "succeeded" || run.model_version_id !== modelId || !run.report_artifact_id) fail("a successful evaluation for this model is required", 409);
  const eligible = await getEligibleGroundTruth(env, run!.ground_truth_version_id, "diagnostic");
  if (!eligible.eligible) fail("evaluation ground truth is no longer eligible", 409);
  const { bytes } = await verifiedArtifact(env, run!.report_artifact_id);
  const report = JSON.parse(new TextDecoder().decode(bytes));
  if (report.input_sha256 !== run!.input_sha256 || report.evaluation_run_id !== run!.id) fail("evaluation report does not match its run", 422);
  const inputs = JSON.parse(run!.configuration_json);
  const model = await env.CONTROL_DB.prepare("SELECT artifact_id FROM model_versions WHERE id = ?").bind(modelId).first<Row>();
  const artifact = await verifiedArtifact(env, model!.artifact_id);
  if (inputs.model.sha256 !== artifact.row.sha256 || report.model_sha256 !== artifact.row.sha256) fail("evaluation model checksum mismatch", 422);
  const metrics = record(report.metrics, "report metrics");
  for (const metric of ["object_precision", "object_recall", "object_f1"]) {
    if (enforceAcceptance && (typeof metrics[metric] !== "number" || !Number.isFinite(metrics[metric]) || metrics[metric] < 0 || metrics[metric] > 1)) fail("evaluation metrics are incomplete", 422);
  }
  if (release) {
    const config = JSON.parse(release.configuration_json);
    if (run!.pipeline_release_id !== release.id || inputs.pipeline_release?.configuration_sha256 !== await sha256Hex(release.configuration_json)) fail("evaluation must pin this exact release", 409);
    if (Object.entries(config.thresholds).some(([key, value]) => inputs.configuration[key] !== value)) fail("evaluation thresholds differ from release", 409);
    if (enforceAcceptance && (metrics.object_f1 < config.acceptance.minimum_f1 || metrics.p95_inference_ms > config.acceptance.maximum_p95_inference_ms || !Number.isFinite(metrics.p95_inference_ms))) fail("evaluation does not meet release acceptance thresholds", 409);
  }
  return run!;
}
async function createModel(request: Request, env: AdjudicationEnv, actor: InternalActor) {
  const value = await body(request, 24 * 1024 * 1024);
  keys(value, ["name", "version", "license", "provenance", "configuration", "model_base64"]);
  const name = text(value.name, "name", 120), version = text(value.version, "version", 80), license = text(value.license, "license", 1000);
  const provenance = record(value.provenance, "provenance");
  keys(provenance, ["source", "implementation_version"]);
  text(provenance.source, "provenance.source");
  text(provenance.implementation_version, "provenance.implementation_version", 200);
  const configuration = record(value.configuration, "configuration");
  if (configuration.architecture !== "nanodet-plus-1.5x-416" || Object.keys(configuration).some((key) => key !== "architecture")) fail("only the versioned NanoDet Plus 1.5x 416 engine is supported", 422);
  if (typeof value.model_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.model_base64)) fail("model_base64 must contain an ONNX binary");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value.model_base64), (character) => character.charCodeAt(0)); } catch { return fail("invalid base64 model"); }
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) fail("model must contain 1 byte to 16 MiB", 413);
  const checksum = await sha256Hex(bytes.buffer as ArrayBuffer), modelId = `model_${(await sha256Hex(name)).slice(0, 32)}`, versionId = id("mv"), artifactId = id("artifact_model");
  const storageKey = `models/${versionId}/${checksum}.onnx`, timestamp = new Date().toISOString();
  await env.INTERNAL_ARTIFACTS_BUCKET.put(storageKey, bytes, { httpMetadata: { contentType: "application/onnx" }, customMetadata: { sha256: checksum } });
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("INSERT INTO models (id, name, task_type, created_at) VALUES (?, ?, 'object_detection', ?) ON CONFLICT(id) DO NOTHING").bind(modelId, name, timestamp),
      env.CONTROL_DB.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES (?, 'model', ?, ?, ?, 'application/onnx', ?)").bind(artifactId, storageKey, checksum, bytes.length, timestamp),
      env.CONTROL_DB.prepare("INSERT INTO model_versions (id, model_id, version, artifact_id, configuration_json, provenance_json, license, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)").bind(versionId, modelId, version, artifactId, JSON.stringify(configuration), JSON.stringify(provenance), license, timestamp),
      audit(env, actor, "model.registered", "model_version", versionId, { sha256: checksum, license, provenance }, timestamp),
    ]);
  } catch (cause) { await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey); throw cause; }
  return json({ data: { id: versionId, model_id: modelId, status: "candidate", sha256: checksum, revision: 0 } }, 201);
}
async function createRelease(request: Request, env: AdjudicationEnv, actor: InternalActor) {
  const value = await body(request);
  keys(value, ["version", "model_version_id", "components", "thresholds", "acceptance"]);
  const version = text(value.version, "version", 80);
  if (!safeId(value.model_version_id)) fail("model_version_id required");
  const model = await env.CONTROL_DB.prepare("SELECT id FROM model_versions WHERE id = ? AND status IN ('approved','production')").bind(value.model_version_id).first<Row>();
  if (!model) fail("release requires an approved model", 409);
  const components = record(value.components, "components");
  keys(components, ["sampler", "annotation_schema", "evaluator"]);
  for (const name of ["sampler", "annotation_schema", "evaluator"]) text(components[name], `components.${name}`, 200);
  if (components.sampler !== SAMPLING_IMPLEMENTATION_VERSION || components.annotation_schema !== "object-annotations.v1" || components.evaluator !== EVALUATION_IMPLEMENTATION_VERSION) fail("unsupported schema or engine implementation; use the overview's engine versions");
  const thresholds = record(value.thresholds, "thresholds");
  keys(thresholds, ["minimum_confidence", "nms_threshold", "minimum_iou"]);
  for (const name of ["minimum_confidence", "nms_threshold", "minimum_iou"]) if (typeof thresholds[name] !== "number" || !Number.isFinite(thresholds[name]) || thresholds[name] < 0 || thresholds[name] > 1) fail(`${name} must be between 0 and 1`);
  const acceptance = record(value.acceptance, "acceptance");
  keys(acceptance, ["minimum_f1", "maximum_p95_inference_ms"]);
  if (typeof acceptance.minimum_f1 !== "number" || !Number.isFinite(acceptance.minimum_f1) || acceptance.minimum_f1 < 0 || acceptance.minimum_f1 > 1 || typeof acceptance.maximum_p95_inference_ms !== "number" || !Number.isFinite(acceptance.maximum_p95_inference_ms) || acceptance.maximum_p95_inference_ms <= 0) fail("acceptance requires minimum_f1 in [0,1] and a positive maximum_p95_inference_ms");
  const releaseId = id("release"), timestamp = new Date().toISOString();
  const configuration = { schema_version: "pipeline-release.v1", model_version_id: value.model_version_id, components, thresholds, acceptance };
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("INSERT INTO pipeline_releases (id, version, configuration_json, status, created_at) VALUES (?, ?, ?, 'candidate', ?)").bind(releaseId, version, JSON.stringify(configuration), timestamp),
    audit(env, actor, "release.created", "pipeline_release", releaseId, configuration, timestamp),
  ]);
  return json({ data: { id: releaseId, version, configuration, status: "candidate", revision: 0 } }, 201);
}
export async function handleReleaseGovernance(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  const match = path.match(/^\/api\/internal\/v1\/(models|releases)(?:\/([a-z][a-z0-9_]{1,99})(?:\/(approve|reject|activate|rollback|retire|artifact))?)?$/);
  if (!match) return null;
  try {
    const [, collection, resourceId, action] = match;
    const table = collection === "models" ? "model_versions" : "pipeline_releases", type = collection === "models" ? "model_version" : "pipeline_release";
    if (!resourceId) {
      if (request.method === "POST") return collection === "models" ? await createModel(request, env, actor) : await createRelease(request, env, actor);
      if (request.method !== "GET") fail("method not allowed", 405);
      const limit = Number(url.searchParams.get("limit") ?? 50), offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail("invalid pagination");
      const rows = await env.CONTROL_DB.prepare(collection === "models" ? "SELECT v.*, m.name FROM model_versions v JOIN models m ON m.id = v.model_id ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?" : `SELECT * FROM ${table} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<Row>();
      return json({ data: rows.results, pagination: { limit, offset } });
    }
    const row = await env.CONTROL_DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(resourceId).first<Row>();
    if (!row) fail("resource not found", 404);
    if (request.method === "GET" && !action) {
      const history = await env.CONTROL_DB.prepare("SELECT * FROM internal_audit_events WHERE resource_type = ? AND resource_id = ? ORDER BY id").bind(type, resourceId).all();
      return json({ data: { ...row, history: history.results } });
    }
    if (request.method === "GET" && action === "artifact" && collection === "models") {
      const artifact = await verifiedArtifact(env, row!.artifact_id);
      return new Response(artifact.bytes, { headers: { "content-type": "application/onnx", "cache-control": "no-store", etag: `"${artifact.row.sha256}"` } });
    }
    if (request.method !== "POST" || !action) fail("method not allowed", 405);
    revision(request, row!);
    const value = await body(request);
    keys(value, ["reason", "evaluation_run_id", "target_release_id"]);
    const reason = text(value.reason, "reason");
    const timestamp = new Date().toISOString(), statements: D1PreparedStatement[] = [];
    let next = "", run: Row | null = null;
    if (collection === "models") {
      if (!["approve", "reject", "retire"].includes(action)) fail("invalid model action");
      if (action === "retire") {
        if (!["approved", "production"].includes(row!.status)) fail("only approved models can be retired", 409);
        const active = await env.CONTROL_DB.prepare("SELECT id FROM pipeline_releases WHERE status = 'active' AND json_extract(configuration_json, '$.model_version_id') = ?").bind(resourceId).first();
        if (active) fail("model is used by the active release", 409);
        statements.push(env.CONTROL_DB.prepare("INSERT INTO governance_assertions (valid) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pipeline_releases WHERE status = 'active' AND json_extract(configuration_json, '$.model_version_id') = ?) THEN 1 ELSE 0 END").bind(resourceId));
        next = "retired";
      } else {
        if (row!.status !== "candidate") fail("only candidates can be decided", 409);
        if (!row!.license || !JSON.parse(row!.provenance_json).source) fail("model license and provenance must be registered before a decision", 409);
        run = await evidence(env, value.evaluation_run_id, resourceId, undefined, action === "approve");
        next = action === "approve" ? "approved" : "rejected";
      }
      statements.push(env.CONTROL_DB.prepare("UPDATE model_versions SET status = ?, evaluation_run_id = COALESCE(?, evaluation_run_id), revision = revision + 1 WHERE id = ? AND revision = ? RETURNING id")
        .bind(next, run?.id ?? null, resourceId, row!.revision));
    } else if (action === "approve" || action === "reject") {
      if (row!.status !== "candidate") fail("only release candidates can be decided", 409);
      const modelId = JSON.parse(row!.configuration_json).model_version_id;
      run = await evidence(env, value.evaluation_run_id, modelId, row!, action === "approve");
      next = action === "approve" ? "approved" : "draft";
      statements.push(env.CONTROL_DB.prepare("UPDATE pipeline_releases SET status = ?, approval_status = ?, approved_by = ?, approved_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? RETURNING id")
        .bind(next, action === "approve" ? "approved" : "rejected", actor.kind === "user" ? actor.user.id : null, action === "approve" ? timestamp : null, resourceId, row!.revision));
      statements.push(env.CONTROL_DB.prepare("INSERT INTO pipeline_release_evaluations (pipeline_release_id, evaluation_run_id) VALUES (?, ?)").bind(resourceId, run!.id));
    } else if (action === "activate" || action === "rollback") {
      if (action === "activate" && row!.status !== "approved") fail("only approved releases can be activated", 409);
      let target = row!;
      if (action === "rollback") {
        if (row!.status !== "active" || !safeId(value.target_release_id)) fail("rollback requires an active release and an explicit target", 409);
        const found = await env.CONTROL_DB.prepare("SELECT * FROM pipeline_releases WHERE id = ? AND status = 'superseded' AND approved_at IS NOT NULL").bind(value.target_release_id).first<Row>();
        if (!found) fail("rollback target must be a previously approved superseded release", 409);
        target = found!;
      }
      const modelId = JSON.parse(target.configuration_json).model_version_id;
      const approvedModel = await env.CONTROL_DB.prepare("SELECT id FROM model_versions WHERE id = ? AND status IN ('approved','production')").bind(modelId).first();
      if (!approvedModel) fail("target model is not approved", 409);
      const linked = await env.CONTROL_DB.prepare("SELECT evaluation_run_id FROM pipeline_release_evaluations WHERE pipeline_release_id = ? ORDER BY evaluation_run_id LIMIT 1").bind(target.id).first<Row>();
      run = await evidence(env, linked?.evaluation_run_id, modelId, target);
      statements.push(env.CONTROL_DB.prepare("INSERT INTO governance_assertions (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM model_versions WHERE id = ? AND status IN ('approved','production')) THEN 1 ELSE 0 END").bind(modelId));
      // The assertion executes inside the transaction, before changing any active release.
      statements.push(env.CONTROL_DB.prepare("INSERT INTO governance_assertions (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM pipeline_releases WHERE id = ? AND revision = ? AND status = ?) THEN 1 ELSE 0 END")
        .bind(resourceId, row!.revision, row!.status));
      if (target.id !== resourceId) statements.push(env.CONTROL_DB.prepare("INSERT INTO governance_assertions (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM pipeline_releases WHERE id = ? AND revision = ? AND status = 'superseded') THEN 1 ELSE 0 END").bind(target.id, target.revision));
      statements.push(env.CONTROL_DB.prepare("UPDATE pipeline_releases SET status = ?, revision = revision + 1 WHERE status = 'active'").bind(action === "rollback" ? "rolled_back" : "superseded"));
      statements.push(env.CONTROL_DB.prepare("UPDATE pipeline_releases SET status = 'active', activated_at = ?, revision = revision + 1 WHERE id = ? RETURNING id").bind(timestamp, target.id));
      next = action === "rollback" ? "rolled_back" : "active";
    } else fail("invalid release action");
    if (run) statements.unshift(env.CONTROL_DB.prepare(`INSERT INTO governance_assertions (valid)
      SELECT CASE WHEN EXISTS (SELECT 1 FROM evaluation_runs r JOIN internal_jobs j ON j.id = r.job_id
        JOIN ground_truth_versions g ON g.id = r.ground_truth_version_id
        WHERE r.id = ? AND r.report_artifact_id = ? AND j.status = 'succeeded'
          AND g.status = 'approved' AND g.approval_status = 'approved' AND g.approval_scope = 'diagnostic') THEN 1 ELSE 0 END`)
      .bind(run.id, run.report_artifact_id));
    // Assert the revision in the same transaction as decisions and audit insertion.
    if (action !== "activate" && action !== "rollback") statements.unshift(env.CONTROL_DB.prepare(`INSERT INTO governance_assertions (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND revision = ?) THEN 1 ELSE 0 END`).bind(resourceId, row!.revision));
    statements.push(audit(env, actor, `${collection === "models" ? "model" : "release"}.${action}`, type, resourceId, { reason, evaluation_run_id: run?.id ?? null, target_release_id: value.target_release_id ?? null, from: row!.status, to: next }, timestamp));
    await env.CONTROL_DB.batch(statements);
    return json({ data: { id: resourceId, status: next, revision: Number(row!.revision) + 1 } });
  } catch (cause) {
    if (cause instanceof GovernanceError) return json({ error: { code: "governance_failed", message: cause.message } }, cause.status);
    if (cause instanceof Error && /governance_assertions|UNIQUE constraint/.test(cause.message)) return json({ error: { code: "governance_conflict", message: "resource changed or version already exists; reload" } }, 409);
    throw cause;
  }
}
