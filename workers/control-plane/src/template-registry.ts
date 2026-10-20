/** @type implementation @purpose Register immutable policies and generate prediction-blind templates from verified frame sets. */
import type { AdjudicationEnv } from "./types";
import { sha256Hex } from "./artifact-pipeline";
import { validateFrameSetManifest, type FrameSetManifestV1 } from "./frame-set-manifest";
import { parseValidationProfile } from "./ground-truth-validation";
import type { InternalActor } from "./internal-auth";
import { parseAnnotationRules, type AnnotationRules } from "./managed-annotations";
import { diagnosticReadiness } from "./diagnostic-readiness";

export const ANNOTATION_SCHEMA_VERSION = "object-annotations.v1";
const GENERATOR_VERSION = "object-template.v1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_TEMPLATE_FRAMES = 500;
type Row = Record<string, unknown>;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (code: string, message: string, status: number, details?: unknown) => json({ error: { code, message, ...(details ? { details } : {}) } }, status);
const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Row, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const resourceId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(value);

/** Read checksum-bound bytes once for both campaign creation and private downloads. */
export async function readRegisteredTemplate(env: AdjudicationEnv, id: string, requireReady = false): Promise<{ registration: Row; template: Record<string, any>; bytes: ArrayBuffer } | Response> {
  const row = await env.CONTROL_DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<Row>();
  if (!row) return error("not_found", "template not found", 404);
  if (requireReady && row.status !== "ready") return error("invalid_state", "template must be ready", 409);
  const reference = await env.CONTROL_DB.prepare("SELECT * FROM artifacts WHERE id = ?").bind(row.artifact_id).first<Row>();
  if (!reference || reference.kind !== "template" || reference.media_type !== "application/json") return error("artifact_missing", "template artifact registration is missing or incompatible", 503);
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(String(reference.storage_key));
  if (!stored) return error("artifact_missing", "template artifact is missing from object storage", 503);
  if (stored.size !== Number(reference.size_bytes) || stored.size > MAX_MANIFEST_BYTES) return error("artifact_verification_failed", "template artifact byte size is invalid", 422);
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength !== Number(reference.size_bytes) || await sha256Hex(bytes) !== reference.sha256 || reference.sha256 !== row.sha256) return error("artifact_verification_failed", "template artifact does not match its registered checksum", 422);
  let template: unknown;
  try { template = JSON.parse(new TextDecoder().decode(bytes)); } catch { return error("invalid_template", "template artifact is not valid JSON", 422); }
  if (!object(template) || template.schema_version !== ANNOTATION_SCHEMA_VERSION || !object(template.provenance) || template.provenance.frame_set_id !== row.frame_set_id || template.provenance.policy_version_id !== row.policy_version_id || !Array.isArray(template.sources)) return error("invalid_template", "template provenance does not match its registration", 422);
  return { registration: row, template, bytes };
}

async function body(request: Request): Promise<Row | Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return error("unsupported_media_type", "content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
  try {
    const value: unknown = JSON.parse(text);
    return object(value) ? value : error("invalid_request", "request body must be an object", 400);
  } catch { return error("invalid_json", "request body is not valid JSON", 400); }
}

function pagination(url: URL): { limit: number; offset: number } | Response {
  const limit = url.searchParams.get("limit") ?? "50", offset = url.searchParams.get("offset") ?? "0";
  if (!/^\d+$/.test(limit) || !/^\d+$/.test(offset) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(Number(offset))) return error("invalid_pagination", "limit must be 1-100 and offset a non-negative safe integer", 400);
  return { limit: Number(limit), offset: Number(offset) };
}

function policyRow(row: Row, includeDocument = false) {
  const definition = JSON.parse(String(row.definition_json)) as Row;
  return { id: row.id, policy_id: row.policy_id, name: row.name, task_type: row.task_type, version: row.version, status: row.status, revision: Number(row.revision ?? 0), annotation_schema_version: definition.annotation_schema_version, validation_profile: definition.validation_profile ?? null, annotation_rules: definition.annotation_rules ?? null, sha256: row.sha256, created_at: row.created_at, ...(includeDocument ? { document: definition.document } : {}) };
}

const POLICY_SELECT = "SELECT pv.*, p.name, p.task_type FROM policy_versions pv JOIN policies p ON p.id = pv.policy_id";

export async function templateReadiness(env: AdjudicationEnv, template: Record<string, unknown>) {
  const policy = await env.CONTROL_DB.prepare("SELECT * FROM policy_versions WHERE id = ?").bind((template.provenance as Record<string, string>).policy_version_id).first<Row>();
  if (!policy || policy.sha256 !== (template.provenance as Record<string, string>).policy_sha256 || await sha256Hex(String(policy.definition_json)) !== policy.sha256) return error("policy_verification_failed", "pinned policy is missing or its checksum has changed", 422);
  const result = diagnosticReadiness(JSON.parse(String(policy.definition_json)), template.sources as { source_sha256: string }[]);
  if (policy.status !== "active") result.blockers.push("Select an active policy version for a new campaign.");
  result.diagnostic_ready = result.blockers.length === 0;
  return result;
}

async function registerPolicy(request: Request, env: AdjudicationEnv, actor?: InternalActor): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exact(value, ["name", "version", "annotation_schema_version", "document", "validation_profile", "annotation_rules"]) || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 120 || typeof value.version !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(value.version) || typeof value.document !== "string" || !value.document.trim() || value.document.length > 48000) return error("invalid_request", "name, version, annotation_schema_version, and a non-empty policy document (at most 48000 characters) are required", 400);
  if (value.annotation_schema_version !== ANNOTATION_SCHEMA_VERSION) return error("unsupported_schema", `only ${ANNOTATION_SCHEMA_VERSION} is supported`, 422);
  const name = value.name.trim();
  const policyId = `policy_${(await sha256Hex(name)).slice(0, 32)}`;
  const versionId = `pv_${(await sha256Hex(JSON.stringify([policyId, value.version]))).slice(0, 32)}`;
  let validationProfile, annotationRules;
  try { validationProfile = value.validation_profile === undefined ? undefined : parseValidationProfile(value.validation_profile); annotationRules = value.annotation_rules === undefined ? undefined : parseAnnotationRules(value.annotation_rules); }
  catch (cause) { return error("invalid_profile", cause instanceof Error ? cause.message : "invalid validation profile", 400); }
  const definition = JSON.stringify({ annotation_schema_version: ANNOTATION_SCHEMA_VERSION, document: value.document.trim(), ...(validationProfile ? { validation_profile: validationProfile } : {}), ...(annotationRules ? { annotation_rules: annotationRules } : {}) });
  const checksum = await sha256Hex(definition);
  const existing = await env.CONTROL_DB.prepare(`${POLICY_SELECT} WHERE pv.id = ?`).bind(versionId).first<Row>();
  const duplicate = (row: Row) => row.sha256 === checksum ? json({ data: policyRow(row, true), meta: { deduplicated: true } }) : error("immutable_version_conflict", "this policy version already has a different definition; register a new version", 409);
  if (existing) return duplicate(existing);
  const now = new Date().toISOString();
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("INSERT INTO policies (id, name, task_type, created_at) VALUES (?, ?, 'object_annotation', ?) ON CONFLICT(id) DO NOTHING").bind(policyId, name, now),
      env.CONTROL_DB.prepare("INSERT INTO policy_versions (id, policy_id, version, status, definition_json, sha256, created_at, activated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)").bind(versionId, policyId, value.version, definition, checksum, now, now),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'policy.register', 'policy_version', ?, ?, ?)").bind(actor?.kind === "user" ? actor.user.id : null, versionId, JSON.stringify({ authentication: actor?.kind === "user" ? "email_link_session" : "legacy_administrator_token", sha256: checksum }), now),
    ]);
  } catch (cause) {
    const raced = await env.CONTROL_DB.prepare(`${POLICY_SELECT} WHERE pv.id = ?`).bind(versionId).first<Row>();
    if (raced) return duplicate(raced);
    throw cause;
  }
  return json({ data: policyRow({ id: versionId, policy_id: policyId, name, task_type: "object_annotation", version: value.version, status: "active", definition_json: definition, sha256: checksum, created_at: now }, true) }, 201);
}

/** Mechanical initialization only: no detector output and no completed human pass. */
export function initializeManagedTemplate(manifest: FrameSetManifestV1, policy: { id: string; version: string; sha256: string; annotation_rules?: AnnotationRules }, manifestSha: string) {
  return {
    schema_version: ANNOTATION_SCHEMA_VERSION,
    policy_version: policy.version,
    provenance: { frame_set_id: manifest.frame_set_id, dataset_version_id: manifest.dataset_version_id, manifest_sha256: manifestSha, policy_version_id: policy.id, policy_sha256: policy.sha256, generator_version: GENERATOR_VERSION },
    validation: { valid: true, frame_count: manifest.frame_count, source_count: manifest.source_count, checks: ["manifest_schema", "manifest_checksum", "policy_checksum", "source_membership", "frame_membership", "private_evidence"], ...(policy.annotation_rules ? { annotation_rules: policy.annotation_rules } : {}) },
    review: { independent_passes: 0, predictions_reviewed_before_freeze: false, adjudication_status: "not_started", adjudication_log: [], reviewed_frames: [], assisted_review: { reviewed_frames: [], completed_passes: 0, status: "not_started" } },
    sources: manifest.sources.map((source) => ({
      source: source.dataset_source_id, source_sha256: source.source_sha256,
      frames: source.frames.map((frame) => ({ filename: `${frame.id}.${frame.artifact.media_type === "image/png" ? "png" : frame.artifact.media_type === "image/webp" ? "webp" : "jpg"}`, timestamp_sec: frame.timestamp_seconds, frame_id: frame.id, width: frame.width, height: frame.height, artifact: frame.artifact, objects: [], out_of_taxonomy: [] })),
    })),
  };
}

async function generateTemplate(request: Request, env: AdjudicationEnv, actor?: InternalActor): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exact(value, ["frame_set_id", "policy_version_id", "annotation_schema_version"]) || !resourceId(value.frame_set_id) || !resourceId(value.policy_version_id)) return error("invalid_request", "frame_set_id, policy_version_id, and annotation_schema_version are required", 400);
  if (value.annotation_schema_version !== ANNOTATION_SCHEMA_VERSION) return error("unsupported_schema", `only ${ANNOTATION_SCHEMA_VERSION} is supported`, 422);
  const frameSet = await env.CONTROL_DB.prepare("SELECT * FROM frame_sets WHERE id = ?").bind(value.frame_set_id).first<Row>();
  const policy = await env.CONTROL_DB.prepare(`${POLICY_SELECT} WHERE pv.id = ?`).bind(value.policy_version_id).first<Row>();
  if (!frameSet || !policy) return error("not_found", "frame set or policy version not found", 404);
  if (frameSet.status !== "ready" || policy.status !== "active") return error("invalid_state", "generation requires a ready frame set and an active policy version", 409);
  if (Number(frameSet.frame_count) > MAX_TEMPLATE_FRAMES) return error("generation_limit", `template generation supports at most ${MAX_TEMPLATE_FRAMES} frames`, 422);
  const definition = JSON.parse(String(policy.definition_json)) as Row;
  if (policy.task_type !== "object_annotation" || definition.annotation_schema_version !== ANNOTATION_SCHEMA_VERSION) return error("incompatible_policy", "policy is incompatible with the requested annotation schema", 422);
  if (typeof policy.sha256 !== "string" || await sha256Hex(String(policy.definition_json)) !== policy.sha256) return error("policy_verification_failed", "policy definition checksum does not match its registration", 422);
  const templateId = `tpl_${(await sha256Hex(JSON.stringify([value.frame_set_id, value.policy_version_id, ANNOTATION_SCHEMA_VERSION]))).slice(0, 32)}`;
  const existing = await env.CONTROL_DB.prepare("SELECT * FROM templates WHERE id = ?").bind(templateId).first<Row>();
  if (existing) return existing.status === "ready" ? json({ data: existing, meta: { deduplicated: true } }) : error("invalid_state", "the registered template is not ready", 409);

  const manifestArtifact = await env.CONTROL_DB.prepare("SELECT * FROM artifacts WHERE id = ?").bind(frameSet.manifest_artifact_id).first<Row>();
  if (!manifestArtifact || manifestArtifact.kind !== "frame_manifest" || manifestArtifact.media_type !== "application/json" || Number(manifestArtifact.size_bytes) > MAX_MANIFEST_BYTES) return error("manifest_unavailable", "registered manifest is missing, incompatible, or exceeds the supported size", 422);
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(String(manifestArtifact.storage_key));
  if (!stored) return error("artifact_missing", "registered manifest is missing from object storage", 503);
  if (stored.size !== Number(manifestArtifact.size_bytes) || stored.size > MAX_MANIFEST_BYTES) return error("manifest_verification_failed", "manifest byte size does not match its registration", 422);
  const manifestText = await stored.text();
  const checksum = await sha256Hex(manifestText);
  if (checksum !== frameSet.sha256 || checksum !== manifestArtifact.sha256) return error("manifest_verification_failed", "manifest checksum does not match its registration", 422);
  let candidate: unknown;
  try { candidate = JSON.parse(manifestText); } catch { return error("invalid_manifest", "stored manifest is not valid JSON", 422); }
  const sourceRows = (await env.CONTROL_DB.prepare("SELECT * FROM frame_set_sources WHERE frame_set_id = ? ORDER BY ordinal").bind(frameSet.id).all<Row>()).results;
  const validation = validateFrameSetManifest(candidate, { frameSetId: String(frameSet.id), samplingJobId: String(frameSet.sampling_job_id), datasetVersionId: String(frameSet.dataset_version_id), datasetSourceIds: sourceRows.map((row) => String(row.dataset_source_id)) });
  if (!validation.valid) return error("invalid_manifest", "stored manifest validation failed", 422, { errors: validation.errors });
  const manifest = candidate as FrameSetManifestV1;
  if (definition.validation_profile) {
    const readiness = diagnosticReadiness(definition, manifest.sources);
    if (!readiness.diagnostic_ready) return error("diagnostic_policy_incompatible", "the diagnostic policy cannot qualify this frame set", 422, readiness);
  }
  if (manifest.frame_count !== Number(frameSet.frame_count) || manifest.source_count !== Number(frameSet.source_count)) return error("manifest_verification_failed", "manifest coverage differs from registered coverage", 422);
  const frames = (await env.CONTROL_DB.prepare("SELECT f.*, a.storage_key, a.sha256, a.size_bytes, a.media_type FROM frame_set_frames f JOIN artifacts a ON a.id = f.artifact_id WHERE f.frame_set_id = ? ORDER BY f.dataset_source_id, f.ordinal").bind(frameSet.id).all<Row>()).results;
  if (frames.length !== manifest.frame_count) return error("evidence_mismatch", "registered frame coverage differs from the manifest", 422);
  const frameMap = new Map(frames.map((frame) => [String(frame.id), frame]));
  for (const source of manifest.sources) {
    const registeredSource = sourceRows.find((row) => row.dataset_source_id === source.dataset_source_id);
    if (!registeredSource || registeredSource.source_sha256 !== source.source_sha256 || Number(registeredSource.size_bytes) !== source.size_bytes || Number(registeredSource.duration_seconds) !== source.duration_seconds) return error("source_mismatch", "source provenance differs from the manifest", 422);
    for (const [ordinal, frame] of source.frames.entries()) {
      const registered = frameMap.get(frame.id);
      if (!registered || registered.dataset_source_id !== source.dataset_source_id || Number(registered.ordinal) !== ordinal || registered.artifact_id !== frame.artifact.artifact_id || registered.sha256 !== frame.artifact.sha256 || Number(registered.size_bytes) !== frame.artifact.size_bytes || registered.media_type !== frame.artifact.media_type || Number(registered.timestamp_seconds) !== frame.timestamp_seconds || Number(registered.width) !== frame.width || Number(registered.height) !== frame.height || JSON.stringify(JSON.parse(String(registered.reasons_json))) !== JSON.stringify(frame.reasons)) return error("evidence_mismatch", "frame identity differs from the manifest", 422);
      const evidence = await env.INTERNAL_ARTIFACTS_BUCKET.head(String(registered.storage_key));
      if (!evidence || evidence.size !== frame.artifact.size_bytes || evidence.customMetadata?.sha256 !== frame.artifact.sha256 || evidence.httpMetadata?.contentType !== frame.artifact.media_type) return error("evidence_unavailable", "private frame evidence is missing or its metadata differs from the manifest", 422);
    }
  }
  const template = initializeManagedTemplate(manifest, { id: String(policy.id), version: String(policy.version), sha256: policy.sha256, ...(definition.annotation_rules ? { annotation_rules: parseAnnotationRules(definition.annotation_rules) } : {}) }, checksum);
  const content = JSON.stringify(template), templateSha = await sha256Hex(content);
  const artifactId = `artifact_${templateId}`, key = `templates/${templateId}/${crypto.randomUUID()}/${templateSha}.json`, now = new Date().toISOString();
  await env.INTERNAL_ARTIFACTS_BUCKET.put(key, content, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: templateSha, artifactId } });
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES (?, 'template', ?, ?, ?, 'application/json', ?)").bind(artifactId, key, templateSha, new TextEncoder().encode(content).byteLength, now),
      env.CONTROL_DB.prepare("INSERT INTO templates (id, frame_set_id, policy_version_id, artifact_id, schema_version, status, frame_count, sha256, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)").bind(templateId, frameSet.id, policy.id, artifactId, ANNOTATION_SCHEMA_VERSION, manifest.frame_count, templateSha, now),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'template.generate', 'template', ?, ?, ?)").bind(actor?.kind === "user" ? actor.user.id : null, templateId, JSON.stringify({ authentication: actor?.kind === "user" ? "email_link_session" : "legacy_administrator_token", frame_set_id: frameSet.id, policy_version_id: policy.id, sha256: templateSha, generator_version: GENERATOR_VERSION }), now),
    ]);
  } catch (cause) {
    const raced = await env.CONTROL_DB.prepare("SELECT * FROM templates WHERE id = ?").bind(templateId).first<Row>();
    // Each attempt owns its object key, so losing attempts cannot delete the winner.
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(key);
    if (raced && raced.sha256 === templateSha && raced.status === "ready") return json({ data: raced, meta: { deduplicated: true } });
    throw cause;
  }
  return json({ data: { id: templateId, frame_set_id: frameSet.id, policy_version_id: policy.id, artifact_id: artifactId, schema_version: ANNOTATION_SCHEMA_VERSION, status: "ready", frame_count: manifest.frame_count, sha256: templateSha, created_at: now } }, 201);
}

/** Called only after the Internals administrator guard. */
export async function handleTemplateRegistry(request: Request, env: AdjudicationEnv, actor?: InternalActor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  const readinessPath = path.match(/^\/api\/internal\/v1\/templates\/(tpl_[a-f0-9]{32})\/readiness$/);
  if (readinessPath) {
    if (request.method !== "GET") return error("method_not_allowed", "method not allowed", 405);
    const loaded = await readRegisteredTemplate(env, readinessPath[1], true);
    if (loaded instanceof Response) return loaded;
    const result = await templateReadiness(env, loaded.template);
    return result instanceof Response ? result : json({ data: result });
  }
  const lifecycle = path.match(/^\/api\/internal\/v1\/policies\/([a-z][a-z0-9_]{1,99})\/(deprecate|retire)$/);
  if (lifecycle) {
    if (request.method !== "POST") return error("method_not_allowed", "method not allowed", 405);
    if (!request.headers.has("if-match")) return error("revision_required", "If-Match revision is required", 428);
    const value = await body(request); if (value instanceof Response) return value;
    if (!exact(value, ["reason"]) || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000) return error("invalid_request", "a reason is required", 400);
    const row = await env.CONTROL_DB.prepare("SELECT * FROM policy_versions WHERE id = ?").bind(lifecycle[1]).first<Row>();
    if (!row) return error("not_found", "policy version not found", 404);
    if (request.headers.get("if-match") !== String(row.revision)) return error("stale_revision", "policy changed; reload", 412);
    const next = lifecycle[2] === "deprecate" ? "deprecated" : "retired";
    if (row.status !== "active" && !(row.status === "deprecated" && next === "retired")) return error("invalid_state", "only active policies can be deprecated; active or deprecated policies can be retired", 409);
    try {
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare("INSERT INTO governance_assertions (valid) SELECT CASE WHEN EXISTS (SELECT 1 FROM policy_versions WHERE id = ? AND revision = ?) THEN 1 ELSE 0 END").bind(row.id, row.revision),
        env.CONTROL_DB.prepare("UPDATE policy_versions SET status = ?, revision = revision + 1 WHERE id = ? AND revision = ?").bind(next, row.id, row.revision),
        env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, ?, 'policy_version', ?, ?, ?)")
          .bind(actor?.kind === "user" ? actor.user.id : null, `policy.${lifecycle[2]}`, row.id, JSON.stringify({ reason: value.reason }), new Date().toISOString()),
      ]);
    } catch (cause) { if (cause instanceof Error && cause.message.includes("governance_assertions")) return error("stale_revision", "policy changed; reload", 412); throw cause; }
    return json({ data: { id: row.id, status: next, revision: Number(row.revision) + 1 } });
  }
  const match = path.match(/^\/api\/internal\/v1\/(policies|templates)(?:\/([^/]+)(?:\/(artifact))?)?$/);
  if (!match) return null;
  const [, collection, encodedId, artifact] = match;
  if (request.method === "POST" && !encodedId) return collection === "policies" ? registerPolicy(request, env, actor) : generateTemplate(request, env, actor);
  if (request.method !== "GET") return error("method_not_allowed", "method not allowed", 405);
  if (!encodedId) {
    const page = pagination(url);
    if (page instanceof Response) return page;
    const rows = collection === "policies"
      ? await env.CONTROL_DB.prepare(`${POLICY_SELECT} ORDER BY pv.created_at DESC, pv.id DESC LIMIT ? OFFSET ?`).bind(page.limit + 1, page.offset).all<Row>()
      : await env.CONTROL_DB.prepare("SELECT * FROM templates ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").bind(page.limit + 1, page.offset).all<Row>();
    const hasMore = rows.results.length > page.limit;
    return json({ data: rows.results.slice(0, page.limit).map((row) => collection === "policies" ? policyRow(row) : row), pagination: { ...page, has_more: hasMore, next_offset: hasMore ? page.offset + page.limit : null } });
  }
  const id = decodeURIComponent(encodedId);
  if (collection === "policies") {
    if (artifact) return error("not_found", "route not found", 404);
    const row = await env.CONTROL_DB.prepare(`${POLICY_SELECT} WHERE pv.id = ?`).bind(id).first<Row>();
    return row ? json({ data: policyRow(row, true) }) : error("not_found", "policy version not found", 404);
  }
  const row = await env.CONTROL_DB.prepare("SELECT * FROM templates WHERE id = ?").bind(id).first<Row>();
  if (!row) return error("not_found", "template not found", 404);
  if (!artifact) return json({ data: row });
  const loaded = await readRegisteredTemplate(env, id);
  if (loaded instanceof Response) return loaded;
  return new Response(loaded.bytes, { headers: { "content-type": "application/json", "cache-control": "no-store", etag: `"${String(row.sha256)}"` } });
}
