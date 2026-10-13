/** @type implementation @purpose Host isolated reviewer and adjudicator assignments backed by R2. */
import { compareReviews, type JsonRecord } from "./review-comparison";
import { handleInternalsApi } from "./internals";
import { handleAdminJobAction, handleRunnerApi } from "./job-lifecycle";
import type { AdjudicationEnv } from "./types";
import { handleManagedCampaigns } from "./managed-campaigns";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
type Role = "reviewer-a" | "reviewer-b" | "adjudicator";
type Status = "pending" | "in_progress" | "complete";
interface Assignment { id: string; role: Role; token_hash: string; status: Status; created_at: string; expires_at: string; completed_at?: string; revoked_at?: string; }
interface ReviewRecord {
  id: string;
  created_at: string;
  template: JsonRecord;
  frame_urls: Record<string, string>;
  assignments: Record<Role, Assignment>;
  submissions: Partial<Record<"reviewer-a" | "reviewer-b", JsonRecord>>;
  comparison?: JsonRecord;
  merged?: JsonRecord;
}
interface TokenRecord { review_id: string; assignment_id: string; role: Role; }
interface Principal { kind: "admin" | "assignment"; token?: TokenRecord; }

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
const reviewKey = (id: string) => `reviews/${id}.json`;
const tokenKey = (hash: string) => `tokens/${hash}.json`;
const resultKey = (id: string) => `results/${id}.json`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
const identity = (payload: JsonRecord) => (payload.sources ?? []).map((source: JsonRecord) => [source.source, source.source_sha256, (source.frames ?? []).map((frame: JsonRecord) => [frame.filename, frame.timestamp_sec])]);
const frameKeys = (payload: JsonRecord) => (payload.sources ?? []).flatMap((source: JsonRecord) => (source.frames ?? []).map((frame: JsonRecord) => `${source.source}/${frame.filename}`));

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function body(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("request body is too large");
  try { return JSON.parse(text); } catch { throw new Error("request body must be valid JSON"); }
}
async function getJson<T>(env: AdjudicationEnv, key: string): Promise<T | null> {
  const object = await env.REVIEW_BUCKET.get(key);
  return object ? object.json<T>() : null;
}
async function putJson(env: AdjudicationEnv, key: string, value: unknown): Promise<void> {
  await env.REVIEW_BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}
async function principal(request: Request, env: AdjudicationEnv): Promise<Principal | null> {
  const supplied = bearer(request);
  if (!supplied) return null;
  const adminSecret = env.ADMIN_TOKEN;
  if (adminSecret && supplied === adminSecret) return { kind: "admin" };
  const token = await getJson<TokenRecord>(env, tokenKey(await digest(supplied)));
  if (!token) return null;
  const review = await getJson<ReviewRecord>(env, reviewKey(token.review_id));
  const assignment = review?.assignments[token.role];
  if (!assignment || assignment.id !== token.assignment_id || assignment.revoked_at || Date.parse(assignment.expires_at) <= Date.now()) return null;
  return { kind: "assignment", token };
}
function validateTemplate(template: JsonRecord): void {
  if (!template || !Array.isArray(template.sources) || frameKeys(template).length === 0) throw new Error("template must contain at least one source frame");
  if (!template.policy_version) throw new Error("template must declare policy_version");
}
function validateSubmission(template: JsonRecord, submission: JsonRecord): void {
  if (!submission || submission.policy_version !== template.policy_version) throw new Error("submission policy_version does not match the template");
  if (JSON.stringify(identity(submission)) !== JSON.stringify(identity(template))) throw new Error("submission evidence identity does not match the template");
}
function assertCompleteCoverage(payload: JsonRecord): void {
  const expected = frameKeys(payload).sort();
  const reviewed = payload.review?.reviewed_frames;
  if (!Array.isArray(reviewed) || new Set(reviewed).size !== reviewed.length || JSON.stringify([...reviewed].sort()) !== JSON.stringify(expected)) {
    throw new Error("every manifest frame must be reviewed exactly once before completion");
  }
}
function findFrame(payload: JsonRecord, source: string, filename: string): JsonRecord {
  const frame = (payload.sources ?? []).find((item: JsonRecord) => item.source === source)?.frames?.find((item: JsonRecord) => item.filename === filename);
  if (!frame) throw new Error("unknown frame");
  return frame;
}
function publicAssignment(assignment: Assignment) {
  const { token_hash: _, ...safe } = assignment;
  return safe;
}
function reviewSummary(review: ReviewRecord) {
  return {
    id: review.id,
    created_at: review.created_at,
    assignments: Object.fromEntries(Object.entries(review.assignments).map(([role, assignment]) => [role, publicAssignment(assignment)])),
    comparison_ready: Boolean(review.comparison),
    result_ready: review.assignments.adjudicator.status === "complete",
  };
}
const INTERNAL_AREAS = [
  { id: "datasets", label: "Datasets", status: "available", summary: "D1-backed dataset registration and immutable initial versions are available." },
  { id: "sampling", label: "Sampling jobs", status: "runner_available", summary: "The deployed runner uses durable leases, heartbeats, verified uploads, and frame-set finalization; a production run succeeded, with crash-recovery and resource qualification remaining." },
  { id: "frame-sets", label: "Frame sets", status: "available", summary: "Sampling finalization registers immutable manifests and administrator APIs expose membership and private evidence." },
  { id: "policies", label: "Policies", status: "available", summary: "Administrator-registered immutable policy versions pin object annotation instructions and schema compatibility." },
  { id: "templates", label: "Templates", status: "available", summary: "Verified frame sets and active policies generate registered prediction-blind templates consumed by managed campaigns through template IDs." },
  { id: "reviews", label: "Review campaigns", status: "available", summary: "Template-referenced campaigns use D1-isolated assignments, pinned policy instructions, and private evidence; the legacy review service remains available." },
  { id: "ground-truth", label: "Ground truth", status: "available", summary: "Candidates have checksum-bound validation reports, diagnostic approval/rejection, approved replacements, and evidence-checked eligibility. Named user authentication remains planned." },
  { id: "evaluations", label: "Evaluations", status: "legacy_cli", summary: "Diagnostic CLIs remain available; durable evaluation runs are not implemented yet." },
  { id: "models", label: "Models", status: "planned", summary: "Model registration and lifecycle governance are not implemented yet." },
  { id: "releases", label: "Pipeline releases", status: "planned", summary: "Pipeline promotion, activation, and rollback are not implemented yet." },
] as const;
function internalOverview() {
  return {
    name: "Video Semantic Extractor Internals",
    maturity: "foundation",
    notice: "This workspace is an incremental control-plane foundation, not a complete model-development platform.",
    authentication: "Temporary administrator bearer token; user identities and RBAC are planned.",
    control_plane: {
      binding: "CONTROL_DB",
      engine: "D1",
      status: "schema_foundation",
      databases: {
        control: { binding: "CONTROL_DB", name: "video-semantic-extractor" },
        datasets: { binding: "DATASET_DB", name: "video-semantic-extractor-dataset" },
      },
    },
    invitation_experiences: { review: "/review/", adjudication: "/adjudicate/", status: "preserved" },
    areas: INTERNAL_AREAS,
  };
}
function apiDescription(origin: string) {
  return {
    name: "Video annotation review API",
    version: "1.0",
    documentation: `${origin}/docs`,
    openapi: `${origin}/openapi.json`,
    authentication: "Bearer token; reviewer and adjudicator tokens are assignment-scoped",
    endpoints: [
      { method: "GET", path: "/api/v1", auth: "none", output: "API endpoint catalog" },
      { method: "GET", path: "/api/v1/me", auth: "assignment", output: "Authenticated assignment and links" },
      { method: "GET", path: "/api/v1/assignments/{id}", auth: "matching assignment", output: "Private assignment state" },
      { method: "PUT", path: "/api/v1/assignments/{id}", auth: "matching reviewer", input: "ReviewerSubmission", output: "SaveResult" },
      { method: "POST", path: "/api/v1/assignments/{id}/complete", auth: "matching reviewer", input: "empty JSON object", output: "CompletionResult" },
      { method: "GET", path: "/api/v1/assignments/{id}/frames/{source}/{filename}", auth: "matching assignment", output: "Proxied evidence bytes" },
      { method: "GET", path: "/api/v1/assignments/{id}/policy", auth: "matching managed assignment", output: "Pinned reviewer instructions" },
      { method: "GET", path: "/api/v1/campaigns/{id}/result", auth: "administrator or matching managed adjudicator", output: "Private adjudicated ground-truth candidate" },
      { method: "GET", path: "/api/v1/adjudications/{id}", auth: "matching adjudicator", output: "Adjudication state" },
      { method: "PUT", path: "/api/v1/adjudications/{id}/frames/{source}/{filename}", auth: "matching adjudicator", input: "AdjudicationResolution", output: "SaveResult" },
      { method: "POST", path: "/api/v1/adjudications/{id}/complete", auth: "matching adjudicator", input: "empty JSON object", output: "CompletionResult" },
      { method: "POST", path: "/api/v1/admin/reviews", auth: "administrator", input: "CreateReview", output: "ReviewInvitations" },
      { method: "GET", path: "/api/v1/admin/reviews", auth: "administrator", output: "ReviewSummary[]; never includes invitation secrets" },
      { method: "POST", path: "/api/v1/admin/reviews/{id}/assignments/{role}/revoke", auth: "administrator", input: "empty JSON object", output: "RevocationResult" },
      { method: "GET", path: "/api/v1/reviews/{id}/result", auth: "administrator or matching adjudicator", output: "Completed merged annotation" },
      { method: "GET", path: "/api/internal/v1/overview", auth: "administrator", output: "Internals capability and implementation status" },
      { method: "POST", path: "/api/internal/v1/review-campaigns", auth: "administrator", input: "CreateCampaign", output: "Campaign and one-time invitations" },
      { method: "GET", path: "/api/internal/v1/review-campaigns", auth: "administrator", output: "Paginated safe progress summaries" },
      { method: "GET", path: "/api/internal/v1/review-campaigns/{id}", auth: "administrator", output: "Campaign progress and audit history" },
      { method: "GET", path: "/api/internal/v1/ground-truth", auth: "administrator", output: "Paginated ground-truth versions" },
      { method: "GET", path: "/api/internal/v1/ground-truth/{id}", auth: "administrator", output: "Validation and decision history" },
      { method: "POST", path: "/api/internal/v1/ground-truth/{id}/validate", auth: "administrator", input: "If-Match revision", output: "Recorded immutable validation report" },
      { method: "POST", path: "/api/internal/v1/ground-truth/{id}/approve", auth: "administrator", input: "GroundTruthApproval and If-Match", output: "Diagnostic approval" },
      { method: "POST", path: "/api/internal/v1/ground-truth/{id}/reject", auth: "administrator", input: "GroundTruthDecision and If-Match", output: "Rejected version" },
      { method: "POST", path: "/api/internal/v1/ground-truth/{id}/supersede", auth: "administrator", input: "GroundTruthReplacement and If-Match", output: "Superseded version" },
      { method: "GET", path: "/api/internal/v1/ground-truth/{id}/eligibility", auth: "administrator", output: "Current diagnostic evaluation eligibility" },
      { method: "POST", path: "/api/internal/v1/review-campaigns/{id}/cancel", auth: "administrator", output: "Cancelled campaign" },
      { method: "POST", path: "/api/internal/v1/review-campaigns/{id}/assignments/{role}/revoke", auth: "administrator", output: "Revoked invitation" },
      { method: "POST", path: "/api/internal/v1/review-campaigns/{id}/assignments/{role}/reissue", auth: "administrator", output: "Replacement one-time invitation" },
      { method: "GET", path: "/api/internal/v1/datasets", auth: "administrator", output: "Paginated datasets" },
      { method: "POST", path: "/api/internal/v1/datasets", auth: "administrator", input: "CreateDataset", output: "Dataset and initial version" },
      { method: "GET", path: "/api/internal/v1/datasets/{id}", auth: "administrator", output: "Dataset and versions" },
      { method: "GET", path: "/api/internal/v1/sampling-jobs", auth: "administrator", output: "Paginated sampling-job records" },
      { method: "GET", path: "/api/internal/v1/runners", auth: "administrator", output: "Available and busy runners seen within six minutes" },
      { method: "POST", path: "/api/internal/v1/sampling-jobs", auth: "administrator", input: "CreateSamplingJob", output: "Queued metadata; does not execute sampling" },
      { method: "GET", path: "/api/internal/v1/sampling-jobs/{id}", auth: "administrator", output: "Sampling-job record with safe attempt history" },
      { method: "POST", path: "/api/internal/v1/sampling-jobs/{id}/cancel", auth: "administrator", output: "Cancellation state" },
      { method: "POST", path: "/api/internal/v1/sampling-jobs/{id}/retry", auth: "administrator", output: "Requeued sampling job" },
      { method: "GET", path: "/api/internal/v1/frame-sets", auth: "administrator", output: "Paginated immutable frame sets" },
      { method: "GET", path: "/api/internal/v1/frame-sets/{id}", auth: "administrator", output: "Frame-set provenance and membership" },
      { method: "GET", path: "/api/internal/v1/frame-sets/{id}/manifest", auth: "administrator", output: "Private canonical manifest" },
      { method: "GET", path: "/api/internal/v1/frame-sets/{id}/frames/{frame_id}/evidence", auth: "administrator", output: "Private frame bytes" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/claim", auth: "runner", input: "RunnerClaim", output: "Job and one-time lease token" },
      { method: "GET", path: "/api/internal/v1/runner/dataset-versions/{id}/sources", auth: "runner", output: "Ordered registered source URLs" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/{id}/heartbeat", auth: "runner lease", output: "Extended lease and cancellation state" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/{id}/artifacts", auth: "runner lease", input: "ArtifactReservation", output: "Server-generated artifact ID and upload path" },
      { method: "PUT", path: "/api/internal/v1/runner/sampling-jobs/{id}/artifacts/{artifact_id}", auth: "runner lease", input: "Raw image bytes", output: "Verified artifact metadata" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/{id}/finalize", auth: "runner lease", input: "frame-set-manifest.v1", output: "Registered immutable frame set" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/{id}/complete", auth: "runner lease", output: "409; metadata-only completion is disabled" },
      { method: "POST", path: "/api/internal/v1/runner/sampling-jobs/{id}/fail", auth: "runner lease", output: "Failed, cancelled, or requeued state" },
    ],
  };
}
function openApi(origin: string): JsonRecord {
  return {
    openapi: "3.1.0",
    info: { title: "Video annotation review API", version: "1.0.0" },
    servers: [{ url: origin }],
    paths: {
      "/api/v1": { get: { summary: "Discover API operations", responses: { "200": { description: "Endpoint catalog" } } } },
      "/api/v1/me": { get: { summary: "Inspect the current assignment", security: [{ bearerAuth: [] }], responses: { "200": { description: "Assignment links" } } } },
      "/api/v1/assignments/{id}": {
        get: { summary: "Read a reviewer assignment", security: [{ bearerAuth: [] }], responses: { "200": { description: "Reviewer assignment" } } },
        put: { summary: "Save a reviewer submission", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReviewerSubmission" } } } }, responses: { "200": { description: "Saved" } } },
      },
      "/api/v1/assignments/{id}/complete": { post: { summary: "Complete a reviewer pass", security: [{ bearerAuth: [] }], responses: { "200": { description: "Completed" } } } },
      "/api/v1/adjudications/{id}": { get: { summary: "Read an adjudication assignment", security: [{ bearerAuth: [] }], responses: { "200": { description: "Adjudication state" } } } },
      "/api/v1/adjudications/{id}/frames/{source}/{filename}": { put: { summary: "Resolve one disagreement frame", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AdjudicationResolution" } } } }, responses: { "200": { description: "Saved" } } } },
      "/api/v1/adjudications/{id}/complete": { post: { summary: "Complete adjudication", security: [{ bearerAuth: [] }], responses: { "200": { description: "Completed" } } } },
      "/api/v1/admin/reviews": {
        get: { summary: "List reviews without invitation secrets", security: [{ bearerAuth: [] }], responses: { "200": { description: "Review summaries" } } },
        post: { summary: "Create a review and one-time invitation URLs", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateReview" } } } }, responses: { "201": { description: "Created" } } },
      },
      "/api/v1/admin/reviews/{id}/assignments/{role}/revoke": { post: { summary: "Revoke an assignment token", security: [{ bearerAuth: [] }], responses: { "200": { description: "Revoked" } } } },
      "/api/internal/v1/overview": { get: { summary: "Inspect Internals capabilities and implementation status", security: [{ bearerAuth: [] }], responses: { "200": { description: "Internals overview" } } } },
      "/api/internal/v1/datasets": {
        get: { summary: "List registered datasets", security: [{ bearerAuth: [] }], responses: { "200": { description: "Datasets" } } },
        post: { summary: "Register a dataset and its initial version", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateDataset" } } } }, responses: { "201": { description: "Dataset created" } } },
      },
      "/api/internal/v1/datasets/{id}": { get: { summary: "Read a dataset and its versions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Dataset" } } } },
      "/api/internal/v1/sampling-jobs": {
        get: { summary: "List sampling-job records", security: [{ bearerAuth: [] }], responses: { "200": { description: "Sampling jobs" } } },
        post: { summary: "Persist queued sampling-job metadata without executing it", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSamplingJob" } } } }, responses: { "202": { description: "Sampling request recorded" } } },
      },
      "/api/internal/v1/runners": { get: { summary: "List available and busy runner heartbeats", security: [{ bearerAuth: [] }], responses: { "200": { description: "Runner presence expiring after six minutes without a heartbeat" } } } },
      "/api/internal/v1/sampling-jobs/{id}": { get: { summary: "Read a sampling-job record", security: [{ bearerAuth: [] }], responses: { "200": { description: "Sampling job" } } } },
      "/api/internal/v1/sampling-jobs/{id}/cancel": { post: { summary: "Cancel or request cancellation of a sampling job", security: [{ bearerAuth: [] }], responses: { "200": { description: "Cancellation state" } } } },
      "/api/internal/v1/sampling-jobs/{id}/retry": { post: { summary: "Retry failed or cancelled sampling work", security: [{ bearerAuth: [] }], responses: { "200": { description: "Requeued" } } } },
      "/api/internal/v1/frame-sets": { get: { summary: "List immutable frame sets", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated frame sets" } } } },
      "/api/internal/v1/frame-sets/{id}": { get: { summary: "Inspect frame-set provenance and membership", security: [{ bearerAuth: [] }], responses: { "200": { description: "Frame set" } } } },
      "/api/internal/v1/frame-sets/{id}/manifest": { get: { summary: "Retrieve a private frame-set manifest", security: [{ bearerAuth: [] }], responses: { "200": { description: "Manifest bytes" } } } },
      "/api/internal/v1/policies": {
        get: { summary: "List registered policy versions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated policy versions" } } },
        post: { summary: "Register and activate an immutable object-annotation policy version", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterPolicy" } } } }, responses: { "201": { description: "Policy version registered" }, "200": { description: "Identical existing version" }, "409": { description: "Immutable version conflict" } } },
      },
      "/api/internal/v1/policies/{id}": { get: { summary: "Inspect a policy version and its instructions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Policy version" } } } },
      "/api/internal/v1/templates": {
        get: { summary: "List registered templates", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated templates" } } },
        post: { summary: "Generate a verified prediction-blind template", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GenerateTemplate" } } } }, responses: { "201": { description: "Template registered" }, "200": { description: "Existing template" }, "422": { description: "Schema, provenance, or evidence validation failed" } } },
      },
      "/api/internal/v1/templates/{id}": { get: { summary: "Inspect registered template metadata", security: [{ bearerAuth: [] }], responses: { "200": { description: "Template" } } } },
      "/api/internal/v1/templates/{id}/artifact": { get: { summary: "Retrieve a private checksum-verified template artifact", security: [{ bearerAuth: [] }], responses: { "200": { description: "Template JSON" } } } },
      "/api/internal/v1/review-campaigns": {
        get: { summary: "List managed campaign progress without invitations or submissions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated campaigns" } } },
        post: { summary: "Create three assignments from a registered template", security: [{ bearerAuth: [] }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateCampaign" } } } }, responses: { "201": { description: "Campaign and one-time invitations" }, "200": { description: "Idempotent existing campaign; secrets are not replayed" } } },
      },
      "/api/internal/v1/review-campaigns/{id}": { get: { summary: "Inspect campaign progress and audit history", security: [{ bearerAuth: [] }], responses: { "200": { description: "Campaign" } } } },
      "/api/internal/v1/review-campaigns/{id}/cancel": { post: { summary: "Cancel a campaign and revoke its assignments", security: [{ bearerAuth: [] }], responses: { "200": { description: "Cancelled" }, "409": { description: "Campaign is terminal" } } } },
      "/api/internal/v1/review-campaigns/{id}/assignments/{role}/revoke": { post: { summary: "Revoke a managed invitation", security: [{ bearerAuth: [] }], responses: { "200": { description: "Revoked" } } } },
      "/api/internal/v1/review-campaigns/{id}/assignments/{role}/reissue": { post: { summary: "Reissue an unfinished managed assignment invitation", security: [{ bearerAuth: [] }], responses: { "200": { description: "New one-time secret; previous token invalidated" }, "409": { description: "Assignment or campaign is terminal" } } } },
      "/api/v1/assignments/{id}/policy": { get: { summary: "Read managed assignment policy instructions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Pinned policy" } } } },
      "/api/v1/campaigns/{id}/result": { get: { summary: "Retrieve an adjudicated candidate for a managed campaign", security: [{ bearerAuth: [] }], responses: { "200": { description: "Checksum-verified candidate, not approved ground truth" } } } },
      "/api/internal/v1/ground-truth": { get: { summary: "List governed ground-truth versions", security: [{ bearerAuth: [] }], responses: { "200": { description: "Paginated versions" } } } },
      "/api/internal/v1/ground-truth/{id}": { get: { summary: "Read candidate metadata, validation runs, and human decision history", security: [{ bearerAuth: [] }], responses: { "200": { description: "Version and evidence history" } } } },
      "/api/internal/v1/ground-truth/{id}/validate": { post: { summary: "Record a bounded synchronous validation against frozen diagnostic rules", security: [{ bearerAuth: [] }], parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }], responses: { "200": { description: "Immutable validation report, including failed gates" }, "412": { description: "Version or evidence changed" }, "428": { description: "Revision required" } } } },
      "/api/internal/v1/ground-truth/{id}/approve": { post: { summary: "Explicitly approve a fully validated candidate for diagnostic evaluation", security: [{ bearerAuth: [] }], parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GroundTruthApproval" } } } }, responses: { "200": { description: "Approval decision recorded" }, "409": { description: "Passing validation or pending state required" }, "422": { description: "Evidence no longer matches validation" } } } },
      "/api/internal/v1/ground-truth/{id}/reject": { post: { summary: "Reject an undecided candidate with an accountable reference and reason", security: [{ bearerAuth: [] }], parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GroundTruthDecision" } } } }, responses: { "200": { description: "Rejection recorded" } } } },
      "/api/internal/v1/ground-truth/{id}/supersede": { post: { summary: "Replace approval with an eligible version over the same frozen template", security: [{ bearerAuth: [] }], parameters: [{ in: "header", name: "If-Match", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GroundTruthReplacement" } } } }, responses: { "200": { description: "Supersession recorded" } } } },
      "/api/internal/v1/ground-truth/{id}/eligibility": { get: { summary: "Recheck approval, decision, reports, and input evidence for diagnostic evaluation", security: [{ bearerAuth: [] }], parameters: [{ in: "query", name: "scope", schema: { const: "diagnostic", default: "diagnostic" } }], responses: { "200": { description: "Eligibility and evidence references or failure reasons" } } } },
      "/api/internal/v1/ground-truth/{id}/artifact": { get: { summary: "Retrieve checksum-verified candidate bytes", security: [{ bearerAuth: [] }], responses: { "200": { description: "Candidate JSON" } } } },
      "/api/internal/v1/ground-truth/{id}/validations/{validation_id}/report": { get: { summary: "Retrieve private immutable validation evidence scoped to a version", security: [{ bearerAuth: [] }], responses: { "200": { description: "Checksum-verified report" } } } },
      "/api/internal/v1/frame-sets/{id}/frames/{frame_id}/evidence": { get: { summary: "Retrieve private frame evidence", security: [{ bearerAuth: [] }], responses: { "200": { description: "Frame bytes" } } } },
      "/api/internal/v1/runner/sampling-jobs/claim": { post: { summary: "Atomically claim eligible sampling work", security: [{ bearerAuth: [] }], responses: { "200": { description: "Job lease or no available work" } } } },
      "/api/internal/v1/runner/dataset-versions/{id}/sources": { get: { summary: "Resolve ordered sources for managed sampling", security: [{ bearerAuth: [] }], responses: { "200": { description: "Dataset-version sources" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/heartbeat": { post: { summary: "Extend a sampling-job lease", security: [{ bearerAuth: [] }], responses: { "200": { description: "Lease extended" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/artifacts": { post: { summary: "Reserve a lease-bound frame artifact", security: [{ bearerAuth: [] }], responses: { "201": { description: "Artifact reservation" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/artifacts/{artifact_id}": { put: { summary: "Upload and checksum-verify reserved frame bytes", security: [{ bearerAuth: [] }], responses: { "200": { description: "Verified upload" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/finalize": { post: { summary: "Validate a manifest and register its immutable frame set", security: [{ bearerAuth: [] }], responses: { "201": { description: "Frame set registered" }, "200": { description: "Previously finalized frame set" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/complete": { post: { deprecated: true, summary: "Metadata-only completion is disabled", security: [{ bearerAuth: [] }], responses: { "409": { description: "Verified frame-set finalization is required" } } } },
      "/api/internal/v1/runner/sampling-jobs/{id}/fail": { post: { summary: "Fail, cancel, or requeue a leased sampling job", security: [{ bearerAuth: [] }], responses: { "200": { description: "Transition recorded" } } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        GroundTruthDecision: { type: "object", additionalProperties: false, required: ["actor_reference", "reason"], properties: { actor_reference: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", minLength: 1, maxLength: 2000 } } },
        GroundTruthApproval: { type: "object", additionalProperties: false, required: ["actor_reference", "reason", "scope", "attestations"], properties: { actor_reference: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", minLength: 1, maxLength: 2000 }, scope: { const: "diagnostic" }, attestations: { type: "object", additionalProperties: false, required: ["policy_reviewed", "independent_humans_confirmed", "predictions_unseen_confirmed", "licensing_scope_confirmed"], properties: { policy_reviewed: { const: true }, independent_humans_confirmed: { const: true }, predictions_unseen_confirmed: { const: true }, licensing_scope_confirmed: { const: true } } } } },
        GroundTruthReplacement: { type: "object", additionalProperties: false, required: ["actor_reference", "reason", "replacement_id"], properties: { actor_reference: { type: "string", minLength: 1, maxLength: 200 }, reason: { type: "string", minLength: 1, maxLength: 2000 }, replacement_id: { type: "string", pattern: "^gt_[a-f0-9]{32}$" } } },
        CreateCampaign: { type: "object", additionalProperties: false, required: ["name", "template_id"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, template_id: { type: "string", pattern: "^tpl_[a-f0-9]{32}$" }, expires_in_hours: { type: "integer", minimum: 1, maximum: 720, default: 168 }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 } } },
        RegisterPolicy: { type: "object", additionalProperties: false, required: ["name", "version", "annotation_schema_version", "document"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, version: { type: "string", pattern: "^[a-zA-Z0-9._-]{1,80}$" }, annotation_schema_version: { const: "object-annotations.v1" }, document: { type: "string", minLength: 1, maxLength: 48000 }, validation_profile: { type: "object", additionalProperties: false, required: ["id", "source_sha256"], properties: { id: { const: "coco-object-diagnostic.v1" }, source_sha256: { type: "array", minItems: 5, maxItems: 5, uniqueItems: true, items: { type: "string", pattern: "^[a-f0-9]{64}$" } } } } } },
        GenerateTemplate: { type: "object", additionalProperties: false, required: ["frame_set_id", "policy_version_id", "annotation_schema_version"], properties: { frame_set_id: { type: "string" }, policy_version_id: { type: "string" }, annotation_schema_version: { const: "object-annotations.v1" } } },
        CreateReview: { type: "object", required: ["id", "template", "frame_urls"], properties: { id: { type: "string", pattern: ID_PATTERN.source }, template: { type: "object" }, frame_urls: { type: "object", additionalProperties: { type: "string", format: "uri" } }, expires_in_hours: { type: "integer", minimum: 1, maximum: 720, default: 168 } } },
        ReviewerSubmission: { type: "object", required: ["policy_version", "review", "sources"], properties: { policy_version: {}, review: { type: "object" }, sources: { type: "array" } } },
        AdjudicationResolution: { type: "object", required: ["frame", "resolution"], properties: { frame: { type: "object" }, resolution: { enum: ["reviewer_a", "reviewer_b", "edited", "ambiguous"] } } },
        CreateDataset: { type: "object", additionalProperties: false, required: ["name", "sources"], properties: { name: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 2000 }, sources: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri", pattern: "^https://" }, display_name: { type: "string", minLength: 1, maxLength: 200 } } } } } },
        CreateSamplingJob: { type: "object", additionalProperties: false, required: ["dataset_version_id", "method"], properties: { dataset_version_id: { type: "string" }, method: { enum: ["scene", "interval", "hybrid"] }, scene_threshold: { type: "number", minimum: 0, maximum: 1 }, interval_seconds: { type: "number", exclusiveMinimum: 0 }, max_frames: { type: "integer", minimum: 1 }, include_final_frame: { type: "boolean", default: true }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 }, max_attempts: { type: "integer", minimum: 1, maximum: 10, default: 3 } } },
      },
    },
  };
}

async function createReview(request: Request, env: AdjudicationEnv, origin: string): Promise<Response> {
  const value = await body(request), id = value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("id must contain 1-64 lowercase letters, digits, underscores, or hyphens");
  if (await getJson<ReviewRecord>(env, reviewKey(id))) return json({ error: "review already exists" }, 409);
  validateTemplate(value.template);
  const frameUrls = value.frame_urls;
  if (!frameUrls || typeof frameUrls !== "object" || Array.isArray(frameUrls)) throw new Error("frame_urls must map every source/filename key to an HTTPS URL");
  const expected = frameKeys(value.template).sort(), supplied = Object.keys(frameUrls).sort();
  if (JSON.stringify(expected) !== JSON.stringify(supplied)) throw new Error("frame_urls must contain the exact template frame set");
  for (const frameUrl of Object.values(frameUrls)) if (typeof frameUrl !== "string" || new URL(frameUrl).protocol !== "https:") throw new Error("frame URLs must use HTTPS");
  const createdAt = now();
  const expiryHours = value.expires_in_hours ?? 168;
  if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 720) throw new Error("expires_in_hours must be an integer from 1 through 720");
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
  const secrets: Record<Role, string> = { "reviewer-a": crypto.randomUUID() + crypto.randomUUID(), "reviewer-b": crypto.randomUUID() + crypto.randomUUID(), adjudicator: crypto.randomUUID() + crypto.randomUUID() };
  const assignments = {} as Record<Role, Assignment>;
  for (const role of Object.keys(secrets) as Role[]) {
    const idPart = role === "adjudicator" ? "adjudicator" : role;
    const assignmentId = `${id}-${idPart}`;
    const tokenHash = await digest(secrets[role]);
    assignments[role] = { id: assignmentId, role, token_hash: tokenHash, status: "pending", created_at: createdAt, expires_at: expiresAt };
    await putJson(env, tokenKey(tokenHash), { review_id: id, assignment_id: assignmentId, role } satisfies TokenRecord);
  }
  const template = clone(value.template);
  template.review = { ...(template.review ?? {}), independent_passes: 0, adjudication_status: "not_started", reviewed_frames: [], manual_pass: { status: "not_started" } };
  const review: ReviewRecord = { id, created_at: createdAt, template, frame_urls: frameUrls, assignments, submissions: {} };
  await putJson(env, reviewKey(id), review);
  const invitations = Object.fromEntries((Object.keys(secrets) as Role[]).map((role) => [role, {
    assignment_id: assignments[role].id,
    url: `${origin}/${role === "adjudicator" ? "adjudicate" : "review"}/#token=${encodeURIComponent(secrets[role])}`,
    api_token: secrets[role],
  }]));
  return json({ created: true, review: reviewSummary(review), invitations, warning: "Invitation secrets are returned only by this response; store and share them securely." }, 201);
}
async function listReviews(env: AdjudicationEnv): Promise<Response> {
  const listed = await env.REVIEW_BUCKET.list({ prefix: "reviews/" });
  const reviews = await Promise.all(listed.objects.map((object) => getJson<ReviewRecord>(env, object.key)));
  return json({ reviews: reviews.filter(Boolean).map((review) => reviewSummary(review!)) });
}
async function revokeAssignment(env: AdjudicationEnv, reviewId: string, role: Role): Promise<Response> {
  const review = await getJson<ReviewRecord>(env, reviewKey(reviewId));
  if (!review) return json({ error: "review not found" }, 404);
  const assignment = review.assignments[role];
  assignment.revoked_at = now();
  await putJson(env, reviewKey(reviewId), review);
  return json({ revoked: true, assignment: publicAssignment(assignment) });
}
async function assignedReview(env: AdjudicationEnv, token: TokenRecord): Promise<ReviewRecord | null> {
  return getJson<ReviewRecord>(env, reviewKey(token.review_id));
}
function requireMatching(principalValue: Principal | null, assignmentId: string, roles: Role[]): TokenRecord | null {
  if (principalValue?.kind !== "assignment" || !principalValue.token || principalValue.token.assignment_id !== assignmentId || !roles.includes(principalValue.token.role)) return null;
  return principalValue.token;
}
async function reviewerState(env: AdjudicationEnv, token: TokenRecord): Promise<Response> {
  const review = await assignedReview(env, token); if (!review) return json({ error: "review not found" }, 404);
  const payload = review.submissions[token.role as "reviewer-a" | "reviewer-b"] ?? review.template;
  return json({ assignment: publicAssignment(review.assignments[token.role]), annotations: payload, frame_count: frameKeys(payload).length });
}
async function saveReviewer(request: Request, env: AdjudicationEnv, token: TokenRecord): Promise<Response> {
  const review = await assignedReview(env, token); if (!review) return json({ error: "review not found" }, 404);
  const assignment = review.assignments[token.role];
  if (assignment.status === "complete") return json({ error: "assignment is already complete" }, 409);
  const submission = await body(request);
  validateSubmission(review.template, submission);
  submission.review = { ...(submission.review ?? {}), independent_passes: 0, adjudication_status: "not_started", manual_pass: { status: "in_progress" } };
  review.submissions[token.role as "reviewer-a" | "reviewer-b"] = submission;
  assignment.status = "in_progress";
  await putJson(env, reviewKey(review.id), review);
  return json({ saved: true, assignment: publicAssignment(assignment) });
}
async function completeReviewer(env: AdjudicationEnv, token: TokenRecord): Promise<Response> {
  const review = await assignedReview(env, token); if (!review) return json({ error: "review not found" }, 404);
  const role = token.role as "reviewer-a" | "reviewer-b", submission = review.submissions[role];
  if (!submission) throw new Error("save the reviewer submission before completion");
  const assignment = review.assignments[role];
  if (assignment.status === "complete") return json({ error: "assignment is already complete" }, 409);
  assertCompleteCoverage(submission);
  const completedAt = now();
  submission.review = { ...submission.review, independent_passes: 1, adjudication_status: "not_started", manual_pass: { status: "complete", completed_at: completedAt } };
  assignment.status = "complete"; assignment.completed_at = completedAt;
  const otherRole = role === "reviewer-a" ? "reviewer-b" : "reviewer-a";
  if (review.assignments[otherRole].status === "complete") {
    const left = review.submissions["reviewer-a"]!, right = review.submissions["reviewer-b"]!;
    review.comparison = compareReviews(left, right);
    review.merged = clone(left);
    review.merged.review = { ...review.merged.review, independent_passes: 2, adjudication_status: "in_progress", adjudication_log: [] };
    review.assignments.adjudicator.status = "in_progress";
  }
  await putJson(env, reviewKey(review.id), review);
  return json({ completed: true, assignment: publicAssignment(assignment), adjudication_ready: Boolean(review.comparison) });
}
async function adjudicationState(env: AdjudicationEnv, token: TokenRecord): Promise<Response> {
  const review = await assignedReview(env, token); if (!review) return json({ error: "review not found" }, 404);
  if (!review.comparison || !review.merged) return json({ error: "both independent reviewer passes must be complete" }, 409);
  return json({ assignment: publicAssignment(review.assignments.adjudicator), reviewer_a: review.submissions["reviewer-a"], reviewer_b: review.submissions["reviewer-b"], comparison: review.comparison, merged: review.merged, result_url: `/api/v1/reviews/${review.id}/result` });
}
async function resolveFrame(request: Request, env: AdjudicationEnv, token: TokenRecord, source: string, filename: string): Promise<Response> {
  const review = await assignedReview(env, token); if (!review?.merged || !review.comparison) return json({ error: "adjudication is not ready" }, 409);
  if (review.assignments.adjudicator.status === "complete") return json({ error: "adjudication is already complete" }, 409);
  const value = await body(request), target = findFrame(review.merged, source, filename), replacement = value.frame;
  if (!replacement || replacement.filename !== filename || replacement.timestamp_sec !== target.timestamp_sec) throw new Error("resolved frame identity cannot change");
  target.objects = replacement.objects ?? []; target.out_of_taxonomy = replacement.out_of_taxonomy ?? [];
  const log = review.merged.review.adjudication_log as JsonRecord[];
  review.merged.review.adjudication_log = log.filter((entry) => entry.source !== source || entry.filename !== filename);
  review.merged.review.adjudication_log.push({ source, filename, resolution: value.resolution ?? "edited", resolved_at: now() });
  await putJson(env, reviewKey(review.id), review);
  return json({ saved: true });
}
async function completeAdjudication(env: AdjudicationEnv, token: TokenRecord): Promise<Response> {
  const review = await assignedReview(env, token); if (!review?.merged || !review.comparison) return json({ error: "adjudication is not ready" }, 409);
  const disagreementFrames = new Set(review.comparison.disagreements.filter((item: JsonRecord) => item.source && item.filename).map((item: JsonRecord) => `${item.source}\0${item.filename}`));
  const resolved = new Set((review.merged.review.adjudication_log ?? []).map((item: JsonRecord) => `${item.source}\0${item.filename}`));
  if ([...disagreementFrames].some((key) => !resolved.has(key))) throw new Error("resolve every disagreement frame before completion");
  const completedAt = now();
  review.merged.review.adjudication_status = "complete";
  review.assignments.adjudicator.status = "complete"; review.assignments.adjudicator.completed_at = completedAt;
  await putJson(env, reviewKey(review.id), review);
  await putJson(env, resultKey(review.id), review.merged);
  return json({ completed: true, result_url: `/api/v1/reviews/${review.id}/result` });
}
async function evidence(env: AdjudicationEnv, token: TokenRecord, source: string, filename: string): Promise<Response> {
  const review = await assignedReview(env, token); if (!review) return json({ error: "review not found" }, 404);
  findFrame(review.template, source, filename);
  const frameUrl = review.frame_urls[`${source}/${filename}`];
  if (!frameUrl) return json({ error: "frame URL not configured" }, 404);
  const upstream = await fetch(frameUrl, { redirect: "follow" });
  if (!upstream.ok) return json({ error: "frame evidence is unavailable" }, 502);
  return new Response(upstream.body, { status: 200, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", "cache-control": "private, max-age=300" } });
}

async function handleControlPlaneRequest(request: Request, env: AdjudicationEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method === "GET" && path === "/") return Response.redirect(`${url.origin}/internals/`, 302);
  if (method === "GET" && (path === "/internals" || path === "/internals/" || path === "/internals/app.js" || path === "/internals/style.css")) {
    const assetPath = path === "/internals" ? "/internals/" : path;
    const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url), request));
    const headers = new Headers(response.headers);
    headers.set("cache-control", path.endsWith(".js") || path.endsWith(".css") ? "private, max-age=300" : "no-store");
    headers.set("x-robots-tag", "noindex");
    return new Response(response.body, { status: response.status, headers });
  }
  if (method === "GET" && ["/review/", "/adjudicate/", "/app.js", "/style.css"].includes(path)) {
    const assetUrl = new URL(path === "/review/" || path === "/adjudicate/" ? "/" : path, url);
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  if (method === "GET" && (path === "/api/v1" || path === "/list")) return json(apiDescription(url.origin));
  if (method === "GET" && path === "/openapi.json") return json(openApi(url.origin));
  if (method === "GET" && path === "/docs") return Response.redirect(`${url.origin}/api/v1`, 302);
  if (method === "GET" && path === "/health") return json({ status: "ok" });
  try {
    const runnerResponse = await handleRunnerApi(request, env);
    if (runnerResponse) return runnerResponse;
  } catch (error) {
    console.error({
      event: "control_plane_runner_handler_failed",
      method: request.method,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "runner request failed" }, 500);
  }
  try {
    const managed = await handleManagedCampaigns(request, env);
    if (managed) return managed;
  } catch (error) {
    console.error({ event: "managed_campaign_handler_failed", method: request.method, error_name: error instanceof Error ? error.name : "UnknownError" });
    return json({ error: "campaign request failed" }, 500);
  }
  const actor = await principal(request, env);
  if (!actor) return json({ error: "unauthorized" }, 401);
  try {
    if (path === "/api/internal/v1/overview") {
      if (actor.kind !== "admin") return json({ error: "forbidden" }, 403);
      return method === "GET" ? json(internalOverview()) : json({ error: "method not allowed" }, 405);
    }
    if (path.startsWith("/api/internal/v1/")) {
      if (actor.kind !== "admin") return json({ error: "forbidden" }, 403);
      const lifecycleResponse = await handleAdminJobAction(request, env);
      if (lifecycleResponse) return lifecycleResponse;
      const response = await handleInternalsApi(request, env);
      if (response) return response;
    }
    if (path === "/api/v1/me" && method === "GET") {
      if (actor.kind !== "assignment" || !actor.token) return json({ actor: { role: "administrator" }, links: { reviews: "/api/v1/admin/reviews" } });
      const token = actor.token;
      return json({ actor: { role: token.role }, assignment_id: token.assignment_id, review_id: token.review_id, links: token.role === "adjudicator" ? { state: `/api/v1/adjudications/${token.assignment_id}`, ui: "/adjudicate/" } : { state: `/api/v1/assignments/${token.assignment_id}`, ui: "/review/" } });
    }
    if (path === "/api/v1/admin/reviews") {
      if (actor.kind !== "admin") return json({ error: "forbidden" }, 403);
      if (method === "POST") return await createReview(request, env, url.origin);
      if (method === "GET") return await listReviews(env);
      return json({ error: "method not allowed" }, 405);
    }
    const revokeMatch = path.match(/^\/api\/v1\/admin\/reviews\/([a-z0-9][a-z0-9_-]{0,63})\/assignments\/(reviewer-a|reviewer-b|adjudicator)\/revoke$/);
    if (revokeMatch) {
      if (actor.kind !== "admin") return json({ error: "forbidden" }, 403);
      return method === "POST" ? await revokeAssignment(env, revokeMatch[1], revokeMatch[2] as Role) : json({ error: "method not allowed" }, 405);
    }
    const assignmentMatch = path.match(/^\/api\/v1\/assignments\/([^/]+)$/);
    if (assignmentMatch) {
      const token = requireMatching(actor, assignmentMatch[1], ["reviewer-a", "reviewer-b"]); if (!token) return json({ error: "forbidden" }, 403);
      if (method === "GET") return await reviewerState(env, token);
      if (method === "PUT") return await saveReviewer(request, env, token);
      return json({ error: "method not allowed" }, 405);
    }
    const assignmentComplete = path.match(/^\/api\/v1\/assignments\/([^/]+)\/complete$/);
    if (assignmentComplete) {
      const token = requireMatching(actor, assignmentComplete[1], ["reviewer-a", "reviewer-b"]); if (!token) return json({ error: "forbidden" }, 403);
      return method === "POST" ? await completeReviewer(env, token) : json({ error: "method not allowed" }, 405);
    }
    const frameMatch = path.match(/^\/api\/v1\/assignments\/([^/]+)\/frames\/([^/]+)\/([^/]+)$/);
    if (frameMatch) {
      const token = requireMatching(actor, frameMatch[1], ["reviewer-a", "reviewer-b", "adjudicator"]); if (!token) return json({ error: "forbidden" }, 403);
      return method === "GET" ? await evidence(env, token, decodeURIComponent(frameMatch[2]), decodeURIComponent(frameMatch[3])) : json({ error: "method not allowed" }, 405);
    }
    const adjudicationMatch = path.match(/^\/api\/v1\/adjudications\/([^/]+)$/);
    if (adjudicationMatch) {
      const token = requireMatching(actor, adjudicationMatch[1], ["adjudicator"]); if (!token) return json({ error: "forbidden" }, 403);
      return method === "GET" ? await adjudicationState(env, token) : json({ error: "method not allowed" }, 405);
    }
    const resolutionMatch = path.match(/^\/api\/v1\/adjudications\/([^/]+)\/frames\/([^/]+)\/([^/]+)$/);
    if (resolutionMatch) {
      const token = requireMatching(actor, resolutionMatch[1], ["adjudicator"]); if (!token) return json({ error: "forbidden" }, 403);
      return method === "PUT" ? await resolveFrame(request, env, token, decodeURIComponent(resolutionMatch[2]), decodeURIComponent(resolutionMatch[3])) : json({ error: "method not allowed" }, 405);
    }
    const adjudicationComplete = path.match(/^\/api\/v1\/adjudications\/([^/]+)\/complete$/);
    if (adjudicationComplete) {
      const token = requireMatching(actor, adjudicationComplete[1], ["adjudicator"]); if (!token) return json({ error: "forbidden" }, 403);
      return method === "POST" ? await completeAdjudication(env, token) : json({ error: "method not allowed" }, 405);
    }
    const resultMatch = path.match(/^\/api\/v1\/reviews\/([a-z0-9][a-z0-9_-]{0,63})\/result$/);
    if (resultMatch && method === "GET") {
      if (actor.kind === "assignment" && actor.token?.review_id !== resultMatch[1]) return json({ error: "forbidden" }, 403);
      if (actor.kind === "assignment" && actor.token?.role !== "adjudicator") return json({ error: "forbidden" }, 403);
      const result = await getJson<JsonRecord>(env, resultKey(resultMatch[1]));
      return result ? json(result) : json({ error: "result not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    console.error({
      event: "control_plane_request_handler_failed",
      method: request.method,
      api: path.startsWith("/api/internal/") ? "internals" : "public",
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: error instanceof Error ? error.message : "invalid request" }, 400);
  }
}

export default {
  async fetch(request: Request, env: AdjudicationEnv): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = Date.now();
    try {
      const response = await handleControlPlaneRequest(request, env);
      if (url.pathname.startsWith("/api/") || response.status >= 500) {
        console.log({
          event: "control_plane_request",
          method: request.method,
          api: url.pathname.startsWith("/api/internal/") ? "internals" : "public",
          status: response.status,
          duration_ms: Date.now() - startedAt,
          ray_id: request.headers.get("cf-ray") ?? undefined,
        });
      }
      return response;
    } catch (error) {
      console.error({
        event: "control_plane_request_failed",
        method: request.method,
        api: url.pathname.startsWith("/api/internal/") ? "internals" : "public",
        duration_ms: Date.now() - startedAt,
        ray_id: request.headers.get("cf-ray") ?? undefined,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  },
} satisfies ExportedHandler<AdjudicationEnv>;
