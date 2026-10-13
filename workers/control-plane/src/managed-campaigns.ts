/** @type implementation @purpose Run template-referenced campaigns with D1-isolated assignments and private evidence. */
import type { AdjudicationEnv } from "./types";
import { readRegisteredTemplate } from "./template-registry";
import { sha256Hex } from "./artifact-pipeline";
import { compareReviews, type JsonRecord } from "./review-comparison";
import { assertManagedCoverage, sameJson, validateFrameAnnotations, validateManagedSubmission } from "./managed-annotations";

type Role = "reviewer-a" | "reviewer-b" | "adjudicator";
const ROLES: Role[] = ["reviewer-a", "reviewer-b", "adjudicator"];
const MAX_SUBMISSION_BYTES = 512 * 1024;
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function fail(message: string, status = 400): never { throw new CampaignError(message, status); }
class CampaignError extends Error { constructor(message: string, public status: number) { super(message); } }
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
const object = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SUBMISSION_BYTES;
function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return fail("invalid evidence path"); }
}

async function body(request: Request, maximum = MAX_SUBMISSION_BYTES): Promise<JsonRecord> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail("content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > maximum) fail("request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximum) fail("request body is too large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("request body is not valid JSON"); }
  if (!object(value)) fail("request body must be a JSON object");
  return value;
}
function expectedRevision(request: Request): number {
  const header = request.headers.get("if-match");
  if (header === null) fail("reload the assignment and send its revision in If-Match", 428);
  if (!/^"?\d+"?$/.test(header) || (header.startsWith('"') !== header.endsWith('"'))) fail("If-Match must contain an assignment revision");
  const value = Number(header.replaceAll('"', ""));
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid assignment revision");
  return value;
}
function publicAssignment(row: JsonRecord) {
  return { id: row.id, role: row.role, status: row.status, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at, completed_at: row.completed_at, revoked_at: row.revoked_at, reviewed_frames: Number(row.reviewed_count ?? 0) };
}
const CAMPAIGN_SELECT = "SELECT c.*, t.frame_count, t.frame_set_id, t.policy_version_id FROM review_campaigns c JOIN templates t ON t.id = c.template_id";
const ASSIGNMENTS_SELECT = "SELECT *, COALESCE(json_array_length(json_extract(submission_json, '$.review.reviewed_frames')), 0) AS reviewed_count FROM campaign_assignments";

async function assignments(env: AdjudicationEnv, campaignId: string): Promise<JsonRecord[]> {
  return (await env.CONTROL_DB.prepare(`${ASSIGNMENTS_SELECT} WHERE campaign_id = ? ORDER BY role`).bind(campaignId).all<JsonRecord>()).results;
}
async function summary(env: AdjudicationEnv, campaign: JsonRecord) {
  return { id: campaign.id, name: campaign.name, template_id: campaign.template_id, template_sha256: campaign.template_sha256, frame_set_id: campaign.frame_set_id, policy_version_id: campaign.policy_version_id, frame_count: campaign.frame_count, status: campaign.status, created_at: campaign.created_at, updated_at: campaign.updated_at, completed_at: campaign.completed_at, assignments: (await assignments(env, campaign.id)).map(publicAssignment) };
}
function audit(env: AdjudicationEnv, action: string, campaignId: string, operation: string, timestamp: string, details: JsonRecord, table = "campaign_assignments") {
  return env.CONTROL_DB.prepare(`INSERT INTO internal_audit_events (action, resource_type, resource_id, details_json, created_at)
    SELECT ?, 'review_campaign', ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE campaign_id = ? AND last_operation_id = ?)`)
    .bind(action, campaignId, JSON.stringify(details), timestamp, campaignId, operation);
}
async function pinnedTemplate(env: AdjudicationEnv, campaign: JsonRecord) {
  const loaded = await readRegisteredTemplate(env, campaign.template_id);
  if (loaded instanceof Response) return loaded;
  if (loaded.registration.sha256 !== campaign.template_sha256) fail("campaign template checksum differs from its pinned registration", 422);
  return loaded;
}
async function pinnedPolicy(env: AdjudicationEnv, template: JsonRecord, requireActive = false): Promise<JsonRecord> {
  const row = await env.CONTROL_DB.prepare("SELECT pv.*, p.name FROM policy_versions pv JOIN policies p ON p.id = pv.policy_id WHERE pv.id = ?").bind(template.provenance.policy_version_id).first<JsonRecord>();
  if (!row || row.sha256 !== template.provenance.policy_sha256 || await sha256Hex(row.definition_json) !== row.sha256 || row.version !== template.policy_version) fail("pinned policy definition is missing or has changed", 422);
  if (requireActive && row.status !== "active") fail("new campaigns require an active policy version", 409);
  const definition = JSON.parse(row.definition_json);
  if (definition.annotation_schema_version !== template.schema_version || typeof definition.document !== "string") fail("pinned policy is incompatible with the template", 422);
  return { id: row.id, name: row.name, version: row.version, sha256: row.sha256, document: definition.document };
}
function invitation(origin: string, assignmentId: string, role: Role, secret: string) {
  return { assignment_id: assignmentId, url: `${origin}/${role === "adjudicator" ? "adjudicate" : "review"}/#token=${encodeURIComponent(secret)}`, api_token: secret };
}

async function createCampaign(request: Request, env: AdjudicationEnv): Promise<Response> {
  const value = await body(request, 64 * 1024), hours = value.expires_in_hours ?? 168;
  if (Object.keys(value).some((key) => !["name", "template_id", "expires_in_hours", "idempotency_key"].includes(key)) || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 120 || typeof value.template_id !== "string" || !/^tpl_[a-f0-9]{32}$/.test(value.template_id)) fail("name and a registered template_id are required; embedded templates and frame URLs are not accepted");
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) fail("expires_in_hours must be an integer from 1 through 720");
  if (value.idempotency_key !== undefined && (typeof value.idempotency_key !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value.idempotency_key))) fail("idempotency_key must contain 1-200 safe characters");
  const duplicate = async (row: JsonRecord) => {
    if (row.template_id !== value.template_id || row.name !== value.name.trim() || row.invitation_hours !== hours) fail("idempotency_key is already associated with a different campaign", 409);
    return json({ data: await summary(env, row), meta: { deduplicated: true }, warning: "Invitation secrets cannot be retrieved again. Reissue an invitation if its original response was lost." });
  };
  if (value.idempotency_key) {
    const existing = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.idempotency_key = ?`).bind(value.idempotency_key).first<JsonRecord>();
    if (existing) return duplicate(existing);
  }
  const loaded = await readRegisteredTemplate(env, value.template_id, true);
  if (loaded instanceof Response) return loaded;
  if (!bounded(loaded.template)) fail("template is too large for the managed review workflow", 422);
  await pinnedPolicy(env, loaded.template, true);
  // Validate the initializer contract before granting any assignment access.
  validateManagedSubmission(loaded.template, loaded.template);
  const campaignId = id("campaign"), timestamp = now();
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  const records = await Promise.all(ROLES.map(async (role) => {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    return { id: id("ca"), role, secret, hash: await sha256Hex(secret) };
  }));
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("INSERT INTO review_campaigns (id, name, template_id, template_sha256, status, idempotency_key, invitation_hours, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?)").bind(campaignId, value.name.trim(), value.template_id, loaded.registration.sha256, value.idempotency_key ?? null, hours, timestamp, timestamp),
      ...records.map((record) => env.CONTROL_DB.prepare("INSERT INTO campaign_assignments (id, campaign_id, role, token_hash, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(record.id, campaignId, record.role, record.hash, timestamp, timestamp, expires)),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (action, resource_type, resource_id, details_json, created_at) VALUES ('campaign.create', 'review_campaign', ?, ?, ?)").bind(campaignId, JSON.stringify({ authentication: "administrator_token", template_id: value.template_id, template_sha256: loaded.registration.sha256 }), timestamp),
    ]);
  } catch (cause) {
    if (value.idempotency_key) {
      const raced = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.idempotency_key = ?`).bind(value.idempotency_key).first<JsonRecord>();
      if (raced) return duplicate(raced);
    }
    throw cause;
  }
  const campaign = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ?`).bind(campaignId).first<JsonRecord>();
  return json({ data: await summary(env, campaign!), invitations: Object.fromEntries(records.map((record) => [record.role, invitation(new URL(request.url).origin, record.id, record.role, record.secret)])), warning: "Invitation secrets are returned only in this response." }, 201);
}

async function handleAdmin(request: Request, env: AdjudicationEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  const token = bearer(request);
  if (!token) fail("administrator token required", 401);
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) fail("administrator access required", 403);
  const base = "/api/internal/v1/review-campaigns";
  if (path === base) {
    if (request.method === "POST") return createCampaign(request, env);
    if (request.method !== "GET") fail("method not allowed", 405);
    const limit = url.searchParams.get("limit") ?? "50", offset = url.searchParams.get("offset") ?? "0";
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) fail("invalid campaign pagination");
    const rows = (await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`).bind(Number(limit) + 1, Number(offset)).all<JsonRecord>()).results;
    const hasMore = rows.length > Number(limit);
    return json({ data: await Promise.all(rows.slice(0, Number(limit)).map((row) => summary(env, row))), pagination: { limit: Number(limit), offset: Number(offset), has_more: hasMore, next_offset: hasMore ? Number(offset) + Number(limit) : null } });
  }
  const match = path.match(/^\/api\/internal\/v1\/review-campaigns\/(campaign_[a-f0-9]{32})(?:\/(cancel|assignments\/(reviewer-a|reviewer-b|adjudicator)\/(revoke|reissue)))?$/);
  if (!match) fail("campaign route not found", 404);
  const campaign = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ?`).bind(match[1]).first<JsonRecord>();
  if (!campaign) fail("campaign not found", 404);
  if (!match[2]) {
    if (request.method !== "GET") fail("method not allowed", 405);
    const events = (await env.CONTROL_DB.prepare("SELECT action, details_json, created_at FROM internal_audit_events WHERE resource_type = 'review_campaign' AND resource_id = ? ORDER BY id").bind(campaign.id).all<JsonRecord>()).results;
    return json({ data: { ...await summary(env, campaign), audit_events: events.map((event) => ({ action: event.action, details: JSON.parse(event.details_json), created_at: event.created_at })), result_url: campaign.status === "completed" ? `/api/v1/campaigns/${campaign.id}/result` : null } });
  }
  if (request.method !== "POST") fail("method not allowed", 405);
  if (campaign.status === "completed" || campaign.status === "cancelled") fail("campaign is already terminal", 409);
  const timestamp = now(), operation = id("op");
  if (match[2] === "cancel") {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("UPDATE review_campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'cancelled')").bind(timestamp, campaign.id),
      env.CONTROL_DB.prepare("UPDATE campaign_assignments SET revoked_at = COALESCE(revoked_at, ?), revision = revision + 1, updated_at = ?, last_operation_id = ? WHERE campaign_id = ? AND EXISTS (SELECT 1 FROM review_campaigns WHERE id = ? AND status = 'cancelled')").bind(timestamp, timestamp, operation, campaign.id, campaign.id),
      audit(env, "campaign.cancel", campaign.id, operation, timestamp, { authentication: "administrator_token" }),
    ]);
    const current = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ?`).bind(campaign.id).first<JsonRecord>();
    if (current?.status !== "cancelled") fail("campaign changed; reload before cancelling", 409);
    return json({ data: await summary(env, current) });
  }
  const role = match[3] as Role, action = match[4];
  const secret = crypto.randomUUID() + crypto.randomUUID(), hash = await sha256Hex(secret);
  const set = action === "revoke" ? "revoked_at = ?" : "token_hash = ?, revoked_at = NULL, expires_at = ?";
  const fields = action === "revoke" ? [timestamp] : [hash, new Date(Date.now() + campaign.invitation_hours * 3600000).toISOString()];
  const results = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(`UPDATE campaign_assignments SET ${set}, revision = revision + 1, updated_at = ?, last_operation_id = ?
      WHERE campaign_id = ? AND role = ? ${action === "reissue" ? "AND status != 'complete'" : ""}
      AND EXISTS (SELECT 1 FROM review_campaigns WHERE id = ? AND status NOT IN ('completed', 'cancelled')) RETURNING *`).bind(...fields, timestamp, operation, campaign.id, role, campaign.id),
    audit(env, `invitation.${action}`, campaign.id, operation, timestamp, { authentication: "administrator_token", role }),
  ]);
  const row = results[0].results?.[0] as JsonRecord | undefined;
  if (!row) fail("assignment cannot be changed in its current state", 409);
  return json({ assignment: publicAssignment(row), ...(action === "reissue" ? { invitation: invitation(url.origin, row.id, role, secret), warning: "The old token is invalid; the new secret is returned only in this response." } : {}) });
}

/** A single versioned assignment write cannot overwrite the other reviewer's row. */
async function writeReviewer(request: Request, env: AdjudicationEnv, actor: JsonRecord, template: JsonRecord, complete: boolean): Promise<Response> {
  const expected = expectedRevision(request);
  if (actor.status === "complete") fail("assignment is already complete", 409);
  if (actor.revision !== expected) fail("assignment changed; reload before saving", 412);
  const submission = complete ? (actor.submission_json ? JSON.parse(actor.submission_json) : fail("save the submission before completion")) : await body(request);
  const normalized = validateManagedSubmission(template, submission);
  if (complete) assertManagedCoverage(normalized);
  const timestamp = now(), operation = id("op");
  normalized.review.independent_passes = complete ? 1 : 0;
  normalized.review.manual_pass = { status: complete ? "complete" : "in_progress", ...(complete ? { completed_at: timestamp } : {}) };
  if (!bounded(normalized)) fail("submission is too large", 413);
  const results = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(`UPDATE campaign_assignments SET submission_json = ?, status = ?, revision = revision + 1, updated_at = ?, completed_at = ?, last_operation_id = ?
      WHERE id = ? AND revision = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND status != 'complete'
      AND EXISTS (SELECT 1 FROM review_campaigns WHERE id = campaign_id AND status NOT IN ('completed', 'cancelled')) RETURNING *`)
      .bind(JSON.stringify(normalized), complete ? "complete" : "in_progress", timestamp, complete ? timestamp : null, operation, actor.id, expected, actor.token_hash, timestamp),
    env.CONTROL_DB.prepare(`UPDATE review_campaigns SET status = CASE WHEN (SELECT COUNT(*) FROM campaign_assignments WHERE campaign_id = review_campaigns.id AND role != 'adjudicator' AND status = 'complete') = 2 THEN 'awaiting_adjudication' ELSE 'active' END, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM campaign_assignments WHERE campaign_id = review_campaigns.id AND last_operation_id = ?)`)
      .bind(timestamp, actor.campaign_id, operation),
    audit(env, complete ? "review.complete" : "review.save", actor.campaign_id, operation, timestamp, { assignment_id: actor.id, role: actor.role, revision: expected + 1 }),
  ]);
  const updated = results[0].results?.[0] as JsonRecord | undefined;
  if (!updated) fail("assignment changed or access was revoked; reload before saving", 412);
  return json({ [complete ? "completed" : "saved"]: true, assignment: publicAssignment(updated), revision: updated.revision });
}

async function adjudication(env: AdjudicationEnv, campaignId: string): Promise<{ row: JsonRecord; reviewers: JsonRecord[] }> {
  const reviewers = (await assignments(env, campaignId)).filter((row) => row.role !== "adjudicator").sort((a, b) => a.role.localeCompare(b.role));
  if (reviewers.length !== 2 || reviewers.some((row) => row.status !== "complete" || !row.submission_json)) fail("both independent reviewer passes must be complete", 409);
  let row = await env.CONTROL_DB.prepare("SELECT * FROM campaign_adjudications WHERE campaign_id = ?").bind(campaignId).first<JsonRecord>();
  if (!row) {
    const left = JSON.parse(reviewers[0].submission_json), right = JSON.parse(reviewers[1].submission_json), comparison = compareReviews(left, right), merged = clone(left), timestamp = now();
    if (new TextEncoder().encode(JSON.stringify(comparison)).byteLength > 1024 * 1024) fail("comparison exceeds the managed review size limit; use a smaller frame set", 422);
    merged.review = { ...merged.review, independent_passes: 2, adjudication_status: "in_progress", adjudication_log: [] };
    await env.CONTROL_DB.prepare("INSERT INTO campaign_adjudications (campaign_id, comparison_json, merged_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(campaign_id) DO NOTHING").bind(campaignId, JSON.stringify(comparison), JSON.stringify(merged), timestamp, timestamp).run();
    row = await env.CONTROL_DB.prepare("SELECT * FROM campaign_adjudications WHERE campaign_id = ?").bind(campaignId).first<JsonRecord>();
  }
  return { row: row!, reviewers };
}

async function writeAdjudication(request: Request, env: AdjudicationEnv, actor: JsonRecord, campaign: JsonRecord, template: JsonRecord, source?: string, filename?: string): Promise<Response> {
  if (actor.status === "complete") fail("adjudication is already complete", 409);
  const expected = expectedRevision(request), state = await adjudication(env, campaign.id);
  if (state.row.revision !== expected) fail("adjudication changed; reload before saving", 412);
  const merged = JSON.parse(state.row.merged_json), comparison = JSON.parse(state.row.comparison_json), timestamp = now(), operation = id("op");
  const complete = source === undefined;
  if (!complete) {
    const value = await body(request);
    if (Object.keys(value).some((key) => !["frame", "resolution"].includes(key)) || !["reviewer_a", "reviewer_b", "edited", "ambiguous"].includes(value.resolution)) fail("frame and a valid resolution are required");
    const target = merged.sources.find((item: JsonRecord) => item.source === source)?.frames.find((frame: JsonRecord) => frame.filename === filename);
    if (!target || !comparison.disagreements.some((item: JsonRecord) => item.source === source && item.filename === filename)) fail("unknown disagreement frame", 404);
    validateFrameAnnotations(value.frame, target);
    if (value.resolution === "reviewer_a" || value.resolution === "reviewer_b") {
      const selected = JSON.parse(state.reviewers[value.resolution === "reviewer_a" ? 0 : 1].submission_json).sources.find((item: JsonRecord) => item.source === source).frames.find((frame: JsonRecord) => frame.filename === filename);
      if (!sameJson(value.frame, selected)) fail("selected reviewer resolution must match that reviewer's frame");
    }
    target.objects = value.frame.objects; target.out_of_taxonomy = value.frame.out_of_taxonomy;
    merged.review.adjudication_log = merged.review.adjudication_log.filter((entry: JsonRecord) => entry.source !== source || entry.filename !== filename);
    merged.review.adjudication_log.push({ source, filename, resolution: value.resolution, resolved_at: timestamp });
  } else {
    const resolved = new Set(merged.review.adjudication_log.map((entry: JsonRecord) => `${entry.source}/${entry.filename}`));
    if (comparison.disagreements.some((entry: JsonRecord) => !resolved.has(`${entry.source}/${entry.filename}`))) fail("resolve every disagreement frame before completion");
    merged.review.adjudication_status = "complete";
  }
  // Checks IDs across all frames, including decisions imported from reviewer B.
  assertManagedCoverage(validateManagedSubmission(template, merged));
  if (!bounded(merged)) fail("merged submission is too large", 413);
  const statements = [env.CONTROL_DB.prepare(`UPDATE campaign_adjudications SET merged_json = ?, revision = revision + 1, last_operation_id = ?, updated_at = ?
    WHERE campaign_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM campaign_assignments a JOIN review_campaigns c ON c.id = a.campaign_id WHERE a.id = ? AND a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ? AND a.status != 'complete' AND c.status NOT IN ('completed', 'cancelled')) RETURNING *`)
    .bind(JSON.stringify(merged), operation, timestamp, campaign.id, expected, actor.id, actor.token_hash, timestamp)];
  let storageKey: string | undefined;
  if (complete) {
    const content = JSON.stringify(merged), sha = await sha256Hex(content), artifactId = `artifact_result_${campaign.id}`, truthId = `gt_${campaign.id.slice(9)}`;
    storageKey = `campaigns/${campaign.id}/results/${operation}.json`;
    await env.INTERNAL_ARTIFACTS_BUCKET.put(storageKey, content, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: sha, artifactId } });
    statements.push(
      env.CONTROL_DB.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) SELECT ?, 'ground_truth', ?, ?, ?, 'application/json', ? WHERE EXISTS (SELECT 1 FROM campaign_adjudications WHERE campaign_id = ? AND last_operation_id = ?)").bind(artifactId, storageKey, sha, new TextEncoder().encode(content).byteLength, timestamp, campaign.id, operation),
      env.CONTROL_DB.prepare("INSERT INTO ground_truth_versions (id, campaign_id, artifact_id, status, created_at) SELECT ?, ?, ?, 'candidate', ? WHERE EXISTS (SELECT 1 FROM campaign_adjudications WHERE campaign_id = ? AND last_operation_id = ?)").bind(truthId, campaign.id, artifactId, timestamp, campaign.id, operation),
    );
  }
  statements.push(
    env.CONTROL_DB.prepare(`UPDATE campaign_assignments SET status = ?, revision = revision + 1, updated_at = ?, completed_at = ?, last_operation_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM campaign_adjudications WHERE campaign_id = ? AND last_operation_id = ?)`)
      .bind(complete ? "complete" : "in_progress", timestamp, complete ? timestamp : null, operation, actor.id, campaign.id, operation),
    env.CONTROL_DB.prepare("UPDATE review_campaigns SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM campaign_adjudications WHERE campaign_id = ? AND last_operation_id = ?)")
      .bind(complete ? "completed" : "adjudicating", timestamp, complete ? timestamp : null, campaign.id, campaign.id, operation),
    audit(env, complete ? "adjudication.complete" : "adjudication.resolve", campaign.id, operation, timestamp, { assignment_id: actor.id, role: actor.role, revision: expected + 1, ...(complete ? { ground_truth_status: "candidate" } : { source, filename }) }, "campaign_adjudications"),
  );
  let results;
  try { results = await env.CONTROL_DB.batch(statements); }
  catch (cause) {
    if (storageKey) {
      const committed = await env.CONTROL_DB.prepare("SELECT last_operation_id FROM campaign_adjudications WHERE campaign_id = ?").bind(campaign.id).first<JsonRecord>();
      if (committed?.last_operation_id === operation) return json({ completed: true, result_url: `/api/v1/campaigns/${campaign.id}/result` });
      await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey);
    }
    throw cause;
  }
  if (!results[0].results?.length) {
    if (storageKey) await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey);
    fail("adjudication changed or access was revoked; reload before saving", 412);
  }
  return json({ [complete ? "completed" : "saved"]: true, revision: expected + 1, ...(complete ? { result_url: `/api/v1/campaigns/${campaign.id}/result`, ground_truth_status: "candidate" } : {}) });
}

async function privateEvidence(env: AdjudicationEnv, template: JsonRecord, source: string, filename: string): Promise<Response> {
  const frame = template.sources.find((item: JsonRecord) => item.source === source)?.frames.find((item: JsonRecord) => item.filename === filename);
  if (!frame) fail("unknown frame", 404);
  const registered = await env.CONTROL_DB.prepare("SELECT a.* FROM frame_set_frames f JOIN artifacts a ON a.id = f.artifact_id WHERE f.frame_set_id = ? AND f.dataset_source_id = ? AND f.id = ? AND f.artifact_id = ?")
    .bind(template.provenance.frame_set_id, source, frame.frame_id, frame.artifact.artifact_id).first<JsonRecord>();
  if (!registered || registered.sha256 !== frame.artifact.sha256 || registered.size_bytes !== frame.artifact.size_bytes || registered.media_type !== frame.artifact.media_type) fail("frame evidence no longer matches the template", 422);
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(registered.storage_key);
  if (!stored) fail("frame evidence is unavailable", 503);
  if (stored.size !== registered.size_bytes || stored.size > 32 * 1024 * 1024) fail("frame evidence byte size is invalid", 422);
  const bytes = await stored.arrayBuffer();
  if (await sha256Hex(bytes) !== registered.sha256) fail("frame evidence checksum verification failed", 422);
  return new Response(bytes, { headers: { "content-type": registered.media_type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
async function result(env: AdjudicationEnv, campaign: JsonRecord): Promise<Response> {
  if (campaign.status !== "completed") fail("campaign result is not ready", 409);
  const artifact = await env.CONTROL_DB.prepare("SELECT a.* FROM ground_truth_versions g JOIN artifacts a ON a.id = g.artifact_id WHERE g.campaign_id = ?").bind(campaign.id).first<JsonRecord>();
  if (!artifact) fail("campaign result registration is missing", 503);
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(artifact.storage_key);
  if (!stored) fail("campaign result is missing", 503);
  if (stored.size !== artifact.size_bytes || stored.size > MAX_SUBMISSION_BYTES) fail("campaign result byte size is invalid", 422);
  const bytes = await stored.arrayBuffer();
  if (await sha256Hex(bytes) !== artifact.sha256) fail("campaign result checksum verification failed", 422);
  return new Response(bytes, { headers: { "content-type": "application/json", "cache-control": "no-store", etag: `"${artifact.sha256}"` } });
}

/** Own only managed IDs; legacy review records and routes retain their behavior. */
export async function handleManagedCampaigns(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  const internal = path === "/api/internal/v1/review-campaigns" || path.startsWith("/api/internal/v1/review-campaigns/");
  const match = path.match(/^\/api\/v1\/(assignments|adjudications)\/(ca_[a-f0-9]{32})(?:\/(complete|policy|frames\/([^/]+)\/([^/]+)))?$/);
  const resultMatch = path.match(/^\/api\/v1\/campaigns\/(campaign_[a-f0-9]{32})\/result$/);
  const me = path === "/api/v1/me" && request.method === "GET";
  if (!internal && !match && !resultMatch && !me) return null;
  // Legacy unit environments omit D1; production always has this binding.
  if (me && typeof env.CONTROL_DB?.prepare !== "function") return null;
  try {
    if (internal) return await handleAdmin(request, env);
    const token = bearer(request);
    if (resultMatch && token === env.ADMIN_TOKEN && env.ADMIN_TOKEN) {
      if (request.method !== "GET") fail("method not allowed", 405);
      const campaign = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ?`).bind(resultMatch[1]).first<JsonRecord>();
      if (!campaign) fail("campaign not found", 404);
      return await result(env, campaign);
    }
    if (me && (!token || token === env.ADMIN_TOKEN)) return null;
    if (!token) fail("assignment token required", 401);
    const actor = await env.CONTROL_DB.prepare("SELECT a.* FROM campaign_assignments a JOIN review_campaigns c ON c.id = a.campaign_id WHERE a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ? AND c.status != 'cancelled'").bind(await sha256Hex(token), now()).first<JsonRecord>();
    if (!actor) { if (me) return null; fail("assignment token is invalid, expired, or revoked", 401); }
    if (me) return json({ actor: { role: actor.role }, assignment_id: actor.id, review_id: actor.campaign_id, campaign_id: actor.campaign_id, links: { state: `/api/v1/${actor.role === "adjudicator" ? "adjudications" : "assignments"}/${actor.id}`, policy: `/api/v1/assignments/${actor.id}/policy`, ui: actor.role === "adjudicator" ? "/adjudicate/" : "/review/" } });
    if (resultMatch) {
      if (actor.role !== "adjudicator" || actor.campaign_id !== resultMatch[1]) fail("forbidden", 403);
    } else if (!match || actor.id !== match[2] || (match[1] === "adjudications" && actor.role !== "adjudicator") || (match[1] === "assignments" && !["frames", "policy"].some((prefix) => match[3]?.startsWith(prefix)) && actor.role === "adjudicator")) fail("forbidden", 403);
    const campaign = await env.CONTROL_DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ?`).bind(actor.campaign_id).first<JsonRecord>();
    if (!campaign) fail("campaign not found", 404);
    if (resultMatch) { if (request.method !== "GET") fail("method not allowed", 405); return await result(env, campaign); }
    const loaded = await pinnedTemplate(env, campaign);
    if (loaded instanceof Response) return loaded;
    const template = loaded.template;
    if (match![3] === "policy") { if (request.method !== "GET") fail("method not allowed", 405); return json({ policy: await pinnedPolicy(env, template) }); }
    if (match![3]?.startsWith("frames/")) {
      if (match![1] === "adjudications") {
        if (request.method !== "PUT") fail("method not allowed", 405);
        return await writeAdjudication(request, env, actor, campaign, template, decoded(match![4]), decoded(match![5]));
      }
      if (request.method !== "GET") fail("method not allowed", 405);
      if (actor.role === "adjudicator") await adjudication(env, campaign.id);
      return await privateEvidence(env, template, decoded(match![4]), decoded(match![5]));
    }
    if (actor.role !== "adjudicator") {
      if (match![3] === "complete") { if (request.method !== "POST") fail("method not allowed", 405); return await writeReviewer(request, env, actor, template, true); }
      if (request.method === "PUT") return await writeReviewer(request, env, actor, template, false);
      if (request.method !== "GET") fail("method not allowed", 405);
      return json({ assignment: publicAssignment(actor), revision: actor.revision, annotations: actor.submission_json ? JSON.parse(actor.submission_json) : template, frame_count: loaded.registration.frame_count, policy: await pinnedPolicy(env, template) });
    }
    if (match![3] === "complete") { if (request.method !== "POST") fail("method not allowed", 405); return await writeAdjudication(request, env, actor, campaign, template); }
    if (request.method !== "GET") fail("method not allowed", 405);
    const state = await adjudication(env, campaign.id);
    return json({ assignment: publicAssignment(actor), revision: state.row.revision, reviewer_a: JSON.parse(state.reviewers[0].submission_json), reviewer_b: JSON.parse(state.reviewers[1].submission_json), comparison: JSON.parse(state.row.comparison_json), merged: JSON.parse(state.row.merged_json), policy: await pinnedPolicy(env, template), result_url: `/api/v1/campaigns/${campaign.id}/result` });
  } catch (cause) {
    if (cause instanceof CampaignError) return json({ error: cause.message }, cause.status);
    // Validation messages contain only contract descriptions; database/storage errors do not.
    if (cause instanceof Error && cause.constructor === Error && /^(frame evidence identity|objects require|objects and|object regions|submission must|source identity|candidate predictions|reviewed_frames|every registered)/.test(cause.message)) return json({ error: cause.message }, 400);
    throw cause;
  }
}
