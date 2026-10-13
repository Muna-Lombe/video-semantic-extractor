/** @type implementation @purpose Persist candidate validation and explicit diagnostic approval decisions. */
import type { AdjudicationEnv } from "./types";
import type { InternalUser } from "./internal-auth";
import type { JsonRecord } from "./review-comparison";
import { compareReviews } from "./review-comparison";
import { assertManagedCoverage, sameJson, validateManagedSubmission } from "./managed-annotations";
import { readRegisteredTemplate } from "./template-registry";
import { sha256Hex } from "./artifact-pipeline";
import { validateFrameSetManifest } from "./frame-set-manifest";
import { parseValidationProfile, VALIDATOR_VERSION, validateGroundTruthContent } from "./ground-truth-validation";

const MAX_BYTES = 512 * 1024;
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
class GovernanceError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }
function fail(code: string, message: string, status = 400): never { throw new GovernanceError(code, message, status); }
const SELECT = `SELECT g.*, c.name AS campaign_name, c.status AS campaign_status, c.template_id,
  c.template_sha256 AS campaign_template_sha256, t.sha256 AS template_sha256, t.policy_version_id, t.frame_set_id,
  pv.sha256 AS policy_sha256, fs.sha256 AS manifest_sha256, a.sha256 AS candidate_sha256,
  a.storage_key AS candidate_storage_key, a.size_bytes AS candidate_size_bytes
  FROM ground_truth_versions g JOIN review_campaigns c ON c.id = g.campaign_id
  JOIN templates t ON t.id = c.template_id JOIN policy_versions pv ON pv.id = t.policy_version_id
  JOIN frame_sets fs ON fs.id = t.frame_set_id JOIN artifacts a ON a.id = g.artifact_id`;

function metadata(row: JsonRecord) {
  return { id: row.id, campaign_id: row.campaign_id, campaign_name: row.campaign_name, template_id: row.template_id, policy_version_id: row.policy_version_id, frame_set_id: row.frame_set_id, artifact_id: row.artifact_id, sha256: row.candidate_sha256, status: row.status, approval_status: row.approval_status, approval_scope: row.approval_scope, revision: row.revision, latest_validation_id: row.latest_validation_id, superseded_by_id: row.superseded_by_id, created_at: row.created_at, approved_at: row.approved_at };
}
async function row(env: AdjudicationEnv, versionId: string): Promise<JsonRecord> {
  const value = await env.CONTROL_DB.prepare(`${SELECT} WHERE g.id = ?`).bind(versionId).first<JsonRecord>();
  if (!value) fail("not_found", "ground-truth candidate not found", 404);
  return value;
}
function revision(request: Request): number {
  const header = request.headers.get("if-match");
  if (header === null) fail("revision_required", "reload the candidate and send its revision in If-Match", 428);
  if (!/^\d+$/.test(header) && !/^"\d+"$/.test(header)) fail("invalid_revision", "If-Match must contain a revision");
  const value = Number(header.replaceAll('"', ""));
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_revision", "invalid candidate revision");
  return value;
}
async function body(request: Request): Promise<JsonRecord> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail("unsupported_media_type", "content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) fail("request_too_large", "decision body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) fail("request_too_large", "decision body is too large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("invalid_json", "decision body is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request", "decision body must be an object");
  return value as JsonRecord;
}
async function bytes(env: AdjudicationEnv, key: string, sha: string, size: number, maximum = MAX_BYTES): Promise<ArrayBuffer> {
  const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(key);
  if (!stored) fail("artifact_missing", "registered artifact is missing from private storage", 503);
  if (stored.size !== size || stored.size > maximum) fail("artifact_mismatch", "artifact byte size differs from its registration", 422);
  const value = await stored.arrayBuffer();
  if (value.byteLength !== size || await sha256Hex(value) !== sha) fail("checksum_mismatch", "artifact checksum differs from its registration", 422);
  return value;
}
function parsed(value: ArrayBuffer): JsonRecord {
  try {
    const object: unknown = JSON.parse(new TextDecoder().decode(value));
    if (!object || typeof object !== "object" || Array.isArray(object)) fail("invalid_artifact", "artifact must contain a JSON object", 422);
    return object as JsonRecord;
  } catch (cause) { if (cause instanceof GovernanceError) throw cause; return fail("invalid_artifact", "artifact is not valid JSON", 422); }
}
function inputs(value: JsonRecord) {
  return { ground_truth_id: value.id, candidate_sha256: value.candidate_sha256, template_sha256: value.campaign_template_sha256, policy_sha256: value.policy_sha256, manifest_sha256: value.manifest_sha256 };
}

/** Verify bytes, D1 lineage, immutable human submissions, and currently available evidence. */
async function context(env: AdjudicationEnv, value: JsonRecord) {
  if (value.campaign_status !== "completed") fail("incomplete_campaign", "candidate campaign is not complete", 422);
  const loaded = await readRegisteredTemplate(env, value.template_id);
  if (loaded instanceof Response) {
    const payload = await loaded.json() as JsonRecord;
    fail(payload.error?.code ?? "invalid_template", payload.error?.message ?? "template is unavailable", loaded.status);
  }
  const template = loaded.template;
  if (loaded.registration.sha256 !== value.campaign_template_sha256 || template.provenance.policy_sha256 !== value.policy_sha256 || template.provenance.manifest_sha256 !== value.manifest_sha256) fail("lineage_mismatch", "candidate inputs differ from their frozen provenance", 422);
  const candidateBytes = await bytes(env, value.candidate_storage_key, value.candidate_sha256, value.candidate_size_bytes), candidate = parsed(candidateBytes);
  const policy = await env.CONTROL_DB.prepare("SELECT * FROM policy_versions WHERE id = ?").bind(value.policy_version_id).first<JsonRecord>();
  if (!policy || await sha256Hex(policy.definition_json) !== value.policy_sha256 || policy.version !== template.policy_version) fail("policy_mismatch", "pinned policy definition is missing or changed", 422);
  let definition: JsonRecord;
  try { definition = JSON.parse(policy.definition_json); } catch { return fail("invalid_policy", "pinned policy is not valid JSON", 422); }
  if (definition.annotation_schema_version !== template.schema_version || typeof definition.document !== "string") fail("invalid_policy", "pinned policy is incompatible with the annotation schema", 422);
  let profile;
  try { profile = definition.validation_profile === undefined ? undefined : parseValidationProfile(definition.validation_profile); }
  catch { fail("invalid_profile", "pinned validation profile is unsupported or malformed", 422); }
  const frameSet = await env.CONTROL_DB.prepare("SELECT * FROM frame_sets WHERE id = ?").bind(value.frame_set_id).first<JsonRecord>();
  if (!frameSet) fail("manifest_missing", "frame-set registration is missing", 422);
  const manifestArtifact = await env.CONTROL_DB.prepare("SELECT * FROM artifacts WHERE id = ?").bind(frameSet.manifest_artifact_id).first<JsonRecord>();
  if (!frameSet || !manifestArtifact || manifestArtifact.sha256 !== value.manifest_sha256) fail("manifest_missing", "frame-set manifest registration is missing or changed", 422);
  const manifest = parsed(await bytes(env, manifestArtifact.storage_key, manifestArtifact.sha256, manifestArtifact.size_bytes, 5 * 1024 * 1024));
  const sourceRows = (await env.CONTROL_DB.prepare("SELECT * FROM frame_set_sources WHERE frame_set_id = ? ORDER BY ordinal").bind(value.frame_set_id).all<JsonRecord>()).results;
  const validation = validateFrameSetManifest(manifest, { frameSetId: value.frame_set_id, samplingJobId: frameSet.sampling_job_id, datasetVersionId: template.provenance.dataset_version_id, datasetSourceIds: sourceRows.map((source) => source.dataset_source_id) });
  if (!validation.valid) fail("invalid_manifest", "stored manifest does not satisfy the frame-set contract", 422);
  const registeredFrames = (await env.CONTROL_DB.prepare("SELECT f.*, a.storage_key, a.sha256, a.size_bytes, a.media_type FROM frame_set_frames f JOIN artifacts a ON a.id = f.artifact_id WHERE f.frame_set_id = ? ORDER BY f.dataset_source_id, f.ordinal").bind(value.frame_set_id).all<JsonRecord>()).results;
  if (manifest.frame_count > 500 || manifest.frame_count !== registeredFrames.length || template.sources.length !== manifest.source_count) fail("coverage_mismatch", "registered frame or source coverage differs from the manifest", 422);
  const frameMap = new Map(registeredFrames.map((frame) => [frame.id, frame]));
  for (const [sourceOrdinal, source] of manifest.sources.entries()) {
    const registeredSource = sourceRows[sourceOrdinal], annotatedSource = template.sources[sourceOrdinal];
    if (!registeredSource || registeredSource.dataset_source_id !== source.dataset_source_id || registeredSource.source_sha256 !== source.source_sha256 || registeredSource.size_bytes !== source.size_bytes || registeredSource.duration_seconds !== source.duration_seconds || annotatedSource?.source !== source.dataset_source_id || annotatedSource.source_sha256 !== source.source_sha256 || annotatedSource.frames.length !== source.frames.length) fail("source_mismatch", "source identity differs across the template, manifest, and membership", 422);
    for (const [ordinal, frame] of source.frames.entries()) {
      const registered = frameMap.get(frame.id), annotated = annotatedSource.frames[ordinal];
      if (!registered || registered.dataset_source_id !== source.dataset_source_id || registered.ordinal !== ordinal || registered.timestamp_seconds !== frame.timestamp_seconds || registered.width !== frame.width || registered.height !== frame.height || registered.artifact_id !== frame.artifact.artifact_id || registered.sha256 !== frame.artifact.sha256 || registered.size_bytes !== frame.artifact.size_bytes || registered.media_type !== frame.artifact.media_type || !sameJson(JSON.parse(registered.reasons_json), frame.reasons) || annotated.frame_id !== frame.id || annotated.timestamp_sec !== frame.timestamp_seconds || annotated.width !== frame.width || annotated.height !== frame.height || !sameJson(annotated.artifact, frame.artifact)) fail("frame_mismatch", "frame identity differs across the template, manifest, and membership", 422);
      const evidence = await env.INTERNAL_ARTIFACTS_BUCKET.head(registered.storage_key);
      if (!evidence || evidence.size !== frame.artifact.size_bytes || evidence.customMetadata?.sha256 !== frame.artifact.sha256 || evidence.httpMetadata?.contentType !== frame.artifact.media_type) fail("evidence_unavailable", "private frame evidence is unavailable or its metadata changed", 422);
    }
  }
  const assignments = (await env.CONTROL_DB.prepare("SELECT id, role, status, submission_json FROM campaign_assignments WHERE campaign_id = ? ORDER BY role").bind(value.campaign_id).all<JsonRecord>()).results;
  if (assignments.length !== 3 || assignments.some((assignment) => assignment.status !== "complete")) fail("incomplete_review", "all three managed assignments must be complete", 422);
  const reviewers = assignments.filter((assignment) => assignment.role !== "adjudicator").sort((a, b) => a.role.localeCompare(b.role));
  const adjudication = await env.CONTROL_DB.prepare("SELECT * FROM campaign_adjudications WHERE campaign_id = ?").bind(value.campaign_id).first<JsonRecord>();
  if (!adjudication || !sameJson(JSON.parse(adjudication.merged_json), candidate)) fail("adjudication_mismatch", "candidate differs from the completed adjudication", 422);
  const left = JSON.parse(reviewers[0].submission_json), right = JSON.parse(reviewers[1].submission_json);
  try {
    for (const submission of [left, right]) {
      assertManagedCoverage(validateManagedSubmission(template, submission));
      if (submission.review.independent_passes !== 1 || submission.review.adjudication_status !== "not_started") throw new Error("invalid independent pass metadata");
    }
  } catch { fail("invalid_review", "frozen independent submissions do not satisfy the registered review contract", 422); }
  const comparison = compareReviews(left, right);
  if (!sameJson(comparison, JSON.parse(adjudication.comparison_json))) fail("comparison_mismatch", "comparison differs from the frozen independent submissions", 422);
  const log = candidate.review?.adjudication_log;
  if (!Array.isArray(log) || log.some((entry: unknown) => !entry || typeof entry !== "object" || Array.isArray(entry))) fail("invalid_adjudication", "candidate adjudication log is missing or malformed", 422);
  const resolved = new Set<string>(log.map((entry: JsonRecord) => `${entry.source}/${entry.filename}`));
  const disagreements = new Set<string>(comparison.disagreements.map((entry: JsonRecord) => `${entry.source}/${entry.filename}`));
  if (resolved.size !== log.length || resolved.size !== disagreements.size || log.some((entry: JsonRecord) => !["reviewer_a", "reviewer_b", "edited", "ambiguous"].includes(entry.resolution)) || [...disagreements].some((key) => !resolved.has(key))) fail("incomplete_adjudication", "adjudication decisions do not cover every disagreement exactly once", 422);
  return { template, candidate, profile, candidateBytes, provenance: { reviewer_submissions: await Promise.all(reviewers.map(async (reviewer) => ({ assignment_id: reviewer.id, sha256: await sha256Hex(reviewer.submission_json) }))), comparison_sha256: await sha256Hex(adjudication.comparison_json), adjudication_sha256: await sha256Hex(adjudication.merged_json) } };
}

function audit(env: AdjudicationEnv, value: JsonRecord, operation: string, action: string, timestamp: string, details: JsonRecord, actorUserId: string | null = null) {
  return env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) SELECT ?, ?, 'ground_truth', ?, ?, ? WHERE EXISTS (SELECT 1 FROM ground_truth_versions WHERE id = ? AND last_operation_id = ?)")
    .bind(actorUserId, action, value.id, JSON.stringify(details), timestamp, value.id, operation);
}
const PIN_GUARD = `EXISTS (SELECT 1 FROM ground_truth_versions g JOIN artifacts a ON a.id = g.artifact_id
  JOIN review_campaigns c ON c.id = g.campaign_id JOIN templates t ON t.id = c.template_id
  JOIN policy_versions pv ON pv.id = t.policy_version_id JOIN frame_sets fs ON fs.id = t.frame_set_id
  WHERE g.id = ? AND a.sha256 = ? AND c.template_sha256 = ? AND t.sha256 = ? AND pv.sha256 = ? AND fs.sha256 = ?)`;
const pinValues = (value: JsonRecord) => [value.id, value.candidate_sha256, value.campaign_template_sha256, value.template_sha256, value.policy_sha256, value.manifest_sha256];

async function validate(request: Request, env: AdjudicationEnv, value: JsonRecord): Promise<Response> {
  const expected = revision(request);
  if (value.revision !== expected) fail("stale_revision", "candidate changed; reload before validating", 412);
  if (value.approval_status !== "pending" || ["approved", "superseded"].includes(value.status)) fail("terminal_version", "decided versions cannot be revalidated", 409);
  const runId = id("gtv"), jobId = id("job"), operation = id("op"), timestamp = now();
  let content: ReturnType<typeof validateGroundTruthContent> | undefined, evidence: JsonRecord | undefined, profile: unknown, integrityError: string | undefined;
  try { const checked = await context(env, value); content = validateGroundTruthContent(checked.template, checked.candidate, checked.profile); evidence = checked.provenance; profile = checked.profile; }
  catch (cause) {
    if (!(cause instanceof GovernanceError) && !(cause instanceof Error && cause.message.startsWith("validation_profile"))) throw cause;
    integrityError = cause.message;
  }
  const passed = Boolean(content?.valid && content.adequate && !integrityError);
  const report = { schema_version: "ground-truth-validation-report.v1", validator_version: VALIDATOR_VERSION, id: runId, created_at: timestamp, inputs: inputs(value), validation_profile: profile ?? null, provenance: evidence ?? null, integrity: { valid: !integrityError, errors: integrityError ? [integrityError] : [], frame_evidence_check: "registered_upload_checksum_and_current_r2_metadata" }, annotation_validation: content ?? null, passed, approval_scope: passed ? "diagnostic" : null };
  const reportText = JSON.stringify(report), reportSha = await sha256Hex(reportText), reportSize = new TextEncoder().encode(reportText).byteLength, storageKey = `ground-truth/${value.id}/validations/${runId}.json`;
  await env.INTERNAL_ARTIFACTS_BUCKET.put(storageKey, reportText, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: reportSha, validationId: runId } });
  let results;
  try {
    results = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(`UPDATE ground_truth_versions SET status = ?, revision = revision + 1, last_operation_id = ? WHERE id = ? AND revision = ? AND approval_status = 'pending' AND status NOT IN ('approved', 'superseded') AND ${PIN_GUARD} RETURNING *`)
        .bind(passed ? "valid" : "invalid", operation, value.id, expected, ...pinValues(value)),
      env.CONTROL_DB.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, output_json, created_at, started_at, completed_at, updated_at) SELECT ?, 'validation', 'succeeded', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ground_truth_versions WHERE id = ? AND last_operation_id = ?)")
        .bind(jobId, JSON.stringify(inputs(value)), JSON.stringify({ validation_id: runId, passed, report_sha256: reportSha }), timestamp, timestamp, timestamp, timestamp, value.id, operation),
      env.CONTROL_DB.prepare("INSERT INTO ground_truth_validations (id, ground_truth_id, job_id, candidate_sha256, template_sha256, policy_sha256, manifest_sha256, validator_version, passed, report_storage_key, report_sha256, report_size_bytes, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ground_truth_versions WHERE id = ? AND last_operation_id = ?)")
        .bind(runId, value.id, jobId, value.candidate_sha256, value.campaign_template_sha256, value.policy_sha256, value.manifest_sha256, VALIDATOR_VERSION, Number(passed), storageKey, reportSha, reportSize, timestamp, value.id, operation),
      env.CONTROL_DB.prepare("UPDATE ground_truth_versions SET latest_validation_id = ?, validation_job_id = ? WHERE id = ? AND last_operation_id = ?").bind(runId, jobId, value.id, operation),
      audit(env, value, operation, "ground_truth.validate", timestamp, { authentication: "administrator_token", validation_id: runId, report_sha256: reportSha, passed }),
    ]);
  } catch (cause) {
    const committed = await env.CONTROL_DB.prepare("SELECT id FROM ground_truth_validations WHERE id = ?").bind(runId).first();
    if (!committed) await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey);
    throw cause;
  }
  if (!results[0].results?.length) { await env.INTERNAL_ARTIFACTS_BUCKET.delete(storageKey); fail("stale_revision", "candidate or pinned inputs changed during validation", 412); }
  return json({ data: metadata(await row(env, value.id)), validation: report });
}

async function verifiedReport(env: AdjudicationEnv, value: JsonRecord) {
  if (!value.latest_validation_id) fail("validation_required", "a current passing validation is required", 409);
  const run = await env.CONTROL_DB.prepare("SELECT * FROM ground_truth_validations WHERE id = ? AND ground_truth_id = ?").bind(value.latest_validation_id, value.id).first<JsonRecord>();
  if (!run || run.passed !== 1 || run.validator_version !== VALIDATOR_VERSION) fail("validation_failed", "latest validation does not permit approval", 409);
  const report = parsed(await bytes(env, run.report_storage_key, run.report_sha256, run.report_size_bytes));
  if (report.passed !== true || report.integrity?.valid !== true || report.annotation_validation?.valid !== true || report.annotation_validation?.adequate !== true || report.validator_version !== VALIDATOR_VERSION || report.approval_scope !== "diagnostic" || !sameJson(report.inputs, inputs(value)) || run.candidate_sha256 !== value.candidate_sha256 || run.template_sha256 !== value.campaign_template_sha256 || run.policy_sha256 !== value.policy_sha256 || run.manifest_sha256 !== value.manifest_sha256) fail("stale_validation", "validation report no longer matches frozen inputs", 422);
  const checked = await context(env, value);
  if (!sameJson(report.provenance, checked.provenance)) fail("review_changed", "review evidence changed after validation", 422);
  return { run, report, checked };
}

/** Future evaluation runners must use this gate instead of trusting a status label. */
export type GroundTruthEligibility = { eligible: false; ground_truth_id: string; reasons: string[] } | { eligible: true; ground_truth_id: string; approval_scope: "diagnostic"; candidate_artifact: { id: string; sha256: string }; template_id: string; validation_id: string; validation_report_sha256: string };
export async function getEligibleGroundTruth(env: AdjudicationEnv, versionId: string, scope = "diagnostic"): Promise<GroundTruthEligibility> {
  if (scope !== "diagnostic") fail("unsupported_scope", "only diagnostic evaluation approval is supported");
  const value = await row(env, versionId);
  if (value.status !== "approved" || value.approval_status !== "approved" || value.approval_scope !== scope) return { eligible: false, ground_truth_id: versionId, reasons: ["version is not approved for this scope"] };
  try {
    const verified = await verifiedReport(env, value);
    const decision = await env.CONTROL_DB.prepare("SELECT id, actor_reference, reason, attestation_json FROM ground_truth_decisions WHERE ground_truth_id = ? AND decision = 'approve' AND validation_id = ? AND candidate_sha256 = ?").bind(versionId, value.latest_validation_id, value.candidate_sha256).first<JsonRecord>();
    if (!decision) fail("decision_missing", "matching approval evidence is missing", 422);
    let attestations: JsonRecord;
    try { attestations = JSON.parse(decision.attestation_json); } catch { fail("decision_invalid", "approval attestations are missing or malformed", 422); }
    if (!decision.actor_reference?.trim() || !decision.reason?.trim() || !attestations || ["policy_reviewed", "independent_humans_confirmed", "predictions_unseen_confirmed", "licensing_scope_confirmed"].some((key) => attestations[key] !== true)) fail("decision_invalid", "approval reference, reason, or attestations are incomplete", 422);
    return { eligible: true, ground_truth_id: versionId, approval_scope: scope, candidate_artifact: { id: value.artifact_id, sha256: value.candidate_sha256 }, template_id: value.template_id, validation_id: verified.run.id, validation_report_sha256: verified.run.report_sha256 };
  } catch (cause) {
    if (cause instanceof GovernanceError) return { eligible: false, ground_truth_id: versionId, reasons: [cause.message] };
    throw cause;
  }
}

async function decide(request: Request, env: AdjudicationEnv, value: JsonRecord, action: "approve" | "reject" | "supersede", authenticatedUser: InternalUser | null): Promise<Response> {
  const expected = revision(request), decision = await body(request);
  const allowed = [...(authenticatedUser ? [] : ["actor_reference"]), "reason", ...(action === "approve" ? ["scope", "attestations"] : action === "supersede" ? ["replacement_id"] : [])];
  const actorReference = authenticatedUser?.email ?? decision.actor_reference;
  if (Object.keys(decision).some((key) => !allowed.includes(key)) || typeof actorReference !== "string" || !actorReference.trim() || actorReference.trim().length > 200 || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.trim().length > 2000) fail("invalid_decision", authenticatedUser ? "reason and decision evidence are required; actor identity is server-derived" : "actor_reference and reason are required and must fit their limits");
  if (value.revision !== expected) fail("stale_revision", "candidate changed; reload before deciding", 412);
  if (action === "supersede" ? value.approval_status !== "approved" || value.status !== "approved" : value.approval_status !== "pending") fail("terminal_version", "this decision is not allowed in the current version state", 409);
  let replacement: JsonRecord | undefined;
  if (action === "approve") {
    if (value.status !== "valid") fail("validation_required", "only a fully validated candidate may be approved", 409);
    if (decision.scope !== "diagnostic") fail("unsupported_scope", "approval is limited to diagnostic evaluation");
    const attestations = decision.attestations;
    const keys = ["policy_reviewed", "independent_humans_confirmed", "predictions_unseen_confirmed", "licensing_scope_confirmed"];
    if (!attestations || typeof attestations !== "object" || Array.isArray(attestations) || Object.keys(attestations).length !== keys.length || keys.some((key) => attestations[key] !== true)) fail("attestations_required", "approval requires explicit policy, human independence, unseen prediction, and licensing attestations");
    await verifiedReport(env, value);
  } else if (action === "supersede") {
    if (typeof decision.replacement_id !== "string" || decision.replacement_id === value.id) fail("invalid_replacement", "a different approved replacement version is required");
    replacement = await row(env, decision.replacement_id);
    if (replacement.template_id !== value.template_id || !(await getEligibleGroundTruth(env, replacement.id)).eligible) fail("invalid_replacement", "replacement must be eligible and reference the same frozen template", 409);
  }
  const timestamp = now(), operation = id("op"), decisionId = id("gtd");
  const status = action === "approve" ? "approved" : action === "reject" ? "invalid" : "superseded";
  const approval = action === "approve" ? "approved" : action === "reject" ? "rejected" : "superseded";
  const replacementGuard = replacement ? " AND EXISTS (SELECT 1 FROM ground_truth_versions WHERE id = ? AND revision = ? AND status = 'approved' AND approval_status = 'approved')" : "";
  const results = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(`UPDATE ground_truth_versions SET status = ?, approval_status = ?, approval_scope = ?, approved_at = ?, superseded_by_id = ?, revision = revision + 1, last_operation_id = ?
      WHERE id = ? AND revision = ? AND approval_status = ? AND latest_validation_id IS ? AND ${PIN_GUARD}${replacementGuard} RETURNING *`)
      .bind(status, approval, action === "reject" ? null : "diagnostic", action === "approve" ? timestamp : value.approved_at, replacement?.id ?? null, operation, value.id, expected, action === "supersede" ? "approved" : "pending", value.latest_validation_id, ...pinValues(value), ...(replacement ? [replacement.id, replacement.revision] : [])),
    env.CONTROL_DB.prepare("INSERT INTO ground_truth_decisions (id, ground_truth_id, decision, actor_reference, reason, attestation_json, validation_id, candidate_sha256, replacement_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ground_truth_versions WHERE id = ? AND last_operation_id = ?)")
      .bind(decisionId, value.id, action, actorReference.trim(), decision.reason.trim(), decision.attestations ? JSON.stringify(decision.attestations) : null, value.latest_validation_id, value.candidate_sha256, replacement?.id ?? null, timestamp, value.id, operation),
    audit(env, value, operation, `ground_truth.${action}`, timestamp, { authentication: authenticatedUser ? "email_link_session" : "legacy_administrator_token", actor_reference: actorReference.trim(), decision_id: decisionId, validation_id: value.latest_validation_id, candidate_sha256: value.candidate_sha256, ...(replacement ? { replacement_id: replacement.id } : {}) }, authenticatedUser?.id ?? null),
  ]);
  if (!results[0].results?.length) fail("stale_revision", "candidate, validation, or replacement changed during the decision", 412);
  return json({ data: metadata(await row(env, value.id)), decision_id: decisionId });
}

/** Called behind the Internals administrator guard. */
export async function handleGroundTruthApi(request: Request, env: AdjudicationEnv, authenticatedUser: InternalUser | null = null): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, ""), base = "/api/internal/v1/ground-truth";
  if (path !== base && !path.startsWith(`${base}/`)) return null;
  try {
    if (path === base) {
      if (request.method !== "GET") fail("method_not_allowed", "method not allowed", 405);
      const limit = url.searchParams.get("limit") ?? "50", offset = url.searchParams.get("offset") ?? "0";
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) fail("invalid_pagination", "invalid pagination");
      const rows = (await env.CONTROL_DB.prepare(`${SELECT} ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?`).bind(Number(limit) + 1, Number(offset)).all<JsonRecord>()).results;
      return json({ data: rows.slice(0, Number(limit)).map(metadata), pagination: { limit: Number(limit), offset: Number(offset), has_more: rows.length > Number(limit), next_offset: rows.length > Number(limit) ? Number(offset) + Number(limit) : null } });
    }
    const match = path.match(/^\/api\/internal\/v1\/ground-truth\/(gt_[a-f0-9]{32})(?:\/(validate|approve|reject|supersede|eligibility|artifact|validations\/(gtv_[a-f0-9]{32})\/report))?$/);
    if (!match) fail("not_found", "ground-truth route not found", 404);
    const value = await row(env, match[1]), action = match[2];
    if (action === "validate" || action === "approve" || action === "reject" || action === "supersede") {
      if (request.method !== "POST") fail("method_not_allowed", "method not allowed", 405);
      return action === "validate" ? await validate(request, env, value) : await decide(request, env, value, action, authenticatedUser);
    }
    if (request.method !== "GET") fail("method_not_allowed", "method not allowed", 405);
    if (action === "eligibility") return json(await getEligibleGroundTruth(env, value.id, url.searchParams.get("scope") ?? "diagnostic"));
    if (action === "artifact") return new Response(await bytes(env, value.candidate_storage_key, value.candidate_sha256, value.candidate_size_bytes), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (action?.startsWith("validations/")) {
      const run = await env.CONTROL_DB.prepare("SELECT * FROM ground_truth_validations WHERE id = ? AND ground_truth_id = ?").bind(match[3], value.id).first<JsonRecord>();
      if (!run) fail("not_found", "validation report not found", 404);
      return new Response(await bytes(env, run.report_storage_key, run.report_sha256, run.report_size_bytes), { headers: { "content-type": "application/json", "cache-control": "no-store", etag: `"${run.report_sha256}"` } });
    }
    const validations = (await env.CONTROL_DB.prepare("SELECT id, job_id, passed, candidate_sha256, report_sha256, validator_version, created_at FROM ground_truth_validations WHERE ground_truth_id = ? ORDER BY created_at DESC, id DESC").bind(value.id).all<JsonRecord>()).results;
    const decisions = (await env.CONTROL_DB.prepare("SELECT id, decision, actor_reference, reason, attestation_json, validation_id, candidate_sha256, replacement_id, created_at FROM ground_truth_decisions WHERE ground_truth_id = ? ORDER BY created_at, id").bind(value.id).all<JsonRecord>()).results;
    return json({ data: { ...metadata(value), validations, decisions: decisions.map((decision) => ({ ...decision, attestations: decision.attestation_json ? JSON.parse(decision.attestation_json) : null, attestation_json: undefined })) } });
  } catch (cause) {
    if (cause instanceof GovernanceError) return json({ error: { code: cause.code, message: cause.message } }, cause.status);
    console.error({ event: "ground_truth_request_failed", error_name: cause instanceof Error ? cause.name : "UnknownError" });
    return json({ error: { code: "internal_error", message: "ground-truth request failed" } }, 500);
  }
}
