/** @type implementation @purpose Host isolated reviewer and adjudicator assignments backed by R2. */
import { compareReviews, type JsonRecord } from "./review-comparison";
import type { AdjudicationEnv } from "./types";

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
      { method: "GET", path: "/api/v1/adjudications/{id}", auth: "matching adjudicator", output: "Adjudication state" },
      { method: "PUT", path: "/api/v1/adjudications/{id}/frames/{source}/{filename}", auth: "matching adjudicator", input: "AdjudicationResolution", output: "SaveResult" },
      { method: "POST", path: "/api/v1/adjudications/{id}/complete", auth: "matching adjudicator", input: "empty JSON object", output: "CompletionResult" },
      { method: "POST", path: "/api/v1/admin/reviews", auth: "administrator", input: "CreateReview", output: "ReviewInvitations" },
      { method: "GET", path: "/api/v1/admin/reviews", auth: "administrator", output: "ReviewSummary[]; never includes invitation secrets" },
      { method: "POST", path: "/api/v1/admin/reviews/{id}/assignments/{role}/revoke", auth: "administrator", input: "empty JSON object", output: "RevocationResult" },
      { method: "GET", path: "/api/v1/reviews/{id}/result", auth: "administrator or matching adjudicator", output: "Completed merged annotation" },
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
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        CreateReview: { type: "object", required: ["id", "template", "frame_urls"], properties: { id: { type: "string", pattern: ID_PATTERN.source }, template: { type: "object" }, frame_urls: { type: "object", additionalProperties: { type: "string", format: "uri" } }, expires_in_hours: { type: "integer", minimum: 1, maximum: 720, default: 168 } } },
        ReviewerSubmission: { type: "object", required: ["policy_version", "review", "sources"], properties: { policy_version: {}, review: { type: "object" }, sources: { type: "array" } } },
        AdjudicationResolution: { type: "object", required: ["frame", "resolution"], properties: { frame: { type: "object" }, resolution: { enum: ["reviewer_a", "reviewer_b", "edited", "ambiguous"] } } },
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

export default { async fetch(request: Request, env: AdjudicationEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method === "GET" && ["/", "/review/", "/adjudicate/", "/app.js", "/style.css"].includes(path)) {
    const assetUrl = new URL(path === "/review/" || path === "/adjudicate/" ? "/" : path, url);
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
  if (method === "GET" && (path === "/api/v1" || path === "/list")) return json(apiDescription(url.origin));
  if (method === "GET" && path === "/openapi.json") return json(openApi(url.origin));
  if (method === "GET" && path === "/docs") return Response.redirect(`${url.origin}/api/v1`, 302);
  if (method === "GET" && path === "/health") return json({ status: "ok" });
  const actor = await principal(request, env);
  if (!actor) return json({ error: "unauthorized" }, 401);
  try {
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
    return json({ error: error instanceof Error ? error.message : "invalid request" }, 400);
  }
} } satisfies ExportedHandler<AdjudicationEnv>;
