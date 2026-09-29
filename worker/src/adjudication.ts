/** @type implementation @purpose Run durable Cloudflare-hosted review adjudication backed by R2. */
import { compareReviews, type JsonRecord } from "./review-comparison";
import type { AdjudicationEnv } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
interface Session { reviewer_a: JsonRecord; reviewer_b: JsonRecord; merged: JsonRecord; comparison: JsonRecord; frame_urls: Record<string, string>; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const sessionKey = (id: string) => `sessions/${id}.json`;
const resultKey = (id: string) => `results/${id}.json`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = (payload: JsonRecord) => (payload.sources ?? []).map((source: JsonRecord) => [source.source, source.source_sha256, (source.frames ?? []).map((frame: JsonRecord) => frame.filename)]);

function authorized(request: Request, env: AdjudicationEnv, url: URL): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  return Boolean(env.ADJUDICATION_TOKEN) && supplied === env.ADJUDICATION_TOKEN;
}
async function body(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("request body is too large");
  try { return JSON.parse(text); } catch { throw new Error("request body must be valid JSON"); }
}
async function load(env: AdjudicationEnv, id: string): Promise<Session | null> {
  const object = await env.REVIEW_BUCKET.get(sessionKey(id));
  return object ? object.json<Session>() : null;
}
async function save(env: AdjudicationEnv, id: string, session: Session): Promise<void> {
  await env.REVIEW_BUCKET.put(sessionKey(id), JSON.stringify(session), { httpMetadata: { contentType: "application/json" } });
}
function findFrame(payload: JsonRecord, source: string, filename: string): JsonRecord {
  const frame = (payload.sources ?? []).find((item: JsonRecord) => item.source === source)?.frames?.find((item: JsonRecord) => item.filename === filename);
  if (!frame) throw new Error("unknown adjudication frame");
  return frame;
}
function validateInputs(left: JsonRecord, right: JsonRecord): void {
  if (!left || !right || left === right) throw new Error("two reviewer payloads are required");
  if (left.policy_version !== right.policy_version) throw new Error("reviewer payloads do not use the same annotation policy");
  if (JSON.stringify(identity(left)) !== JSON.stringify(identity(right))) throw new Error("reviewer payloads do not have identical evidence identity");
  for (const [label, payload] of [["A", left], ["B", right]] as const) {
    if (payload.review?.manual_pass?.status !== "complete") throw new Error(`Reviewer ${label} manual pass is not complete`);
  }
}
async function create(request: Request, env: AdjudicationEnv): Promise<Response> {
  const value = await body(request), id = value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("id must contain 1-64 lowercase letters, digits, underscores, or hyphens");
  if (await load(env, id)) return json({ error: "review already exists" }, 409);
  validateInputs(value.reviewer_a, value.reviewer_b);
  const merged = clone(value.reviewer_a);
  merged.review = { ...merged.review, independent_passes: 2, adjudication_status: "in_progress", adjudication_log: [] };
  const session: Session = { reviewer_a: value.reviewer_a, reviewer_b: value.reviewer_b, merged, comparison: compareReviews(value.reviewer_a, value.reviewer_b), frame_urls: value.frame_urls ?? {} };
  for (const url of Object.values(session.frame_urls)) { const parsed = new URL(url); if (parsed.protocol !== "https:") throw new Error("frame URLs must use HTTPS"); }
  await save(env, id, session);
  return json({ created: true, id, ui_url: `/?review=${encodeURIComponent(id)}` }, 201);
}
async function mutate(request: Request, env: AdjudicationEnv, id: string, action: string): Promise<Response> {
  const session = await load(env, id); if (!session) return json({ error: "review not found" }, 404);
  if (session.merged.review.adjudication_status === "complete") return json({ error: "adjudication is already complete" }, 409);
  if (action === "resolve") {
    const value = await body(request), target = findFrame(session.merged, value.source, value.filename), replacement = value.frame;
    if (!replacement || replacement.filename !== value.filename || replacement.timestamp_sec !== target.timestamp_sec) throw new Error("resolved frame identity cannot change");
    target.objects = replacement.objects ?? []; target.out_of_taxonomy = replacement.out_of_taxonomy ?? [];
    const log = session.merged.review.adjudication_log as JsonRecord[];
    session.merged.review.adjudication_log = log.filter((entry) => entry.source !== value.source || entry.filename !== value.filename);
    session.merged.review.adjudication_log.push({ source: value.source, filename: value.filename, resolution: value.resolution ?? "edited" });
    await save(env, id, session); return json({ saved: true });
  }
  const disagreementFrames = new Set(session.comparison.disagreements.filter((item: JsonRecord) => item.source && item.filename).map((item: JsonRecord) => `${item.source}\0${item.filename}`));
  const resolved = new Set((session.merged.review.adjudication_log ?? []).map((item: JsonRecord) => `${item.source}\0${item.filename}`));
  if ([...disagreementFrames].some((key) => !resolved.has(key))) throw new Error("resolve every disagreement frame before completion");
  session.merged.review.adjudication_status = "complete";
  await save(env, id, session);
  await env.REVIEW_BUCKET.put(resultKey(id), JSON.stringify(session.merged, null, 2) + "\n", { httpMetadata: { contentType: "application/json" } });
  return json({ saved: true, result_url: `/results/${id}.json` });
}

export default { async fetch(request: Request, env: AdjudicationEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === "GET" && (path === "/" || path === "/app.js" || path === "/style.css")) return env.ASSETS.fetch(request);
  const resultMatch = path.match(/^\/results\/([a-z0-9][a-z0-9_-]{0,63})\.json$/);
  if (request.method === "GET" && resultMatch) { const object = await env.REVIEW_BUCKET.get(resultKey(resultMatch[1])); return object ? new Response(object.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } }) : json({ error: "result not found" }, 404); }
  if (path === "/health" && request.method === "GET") return json({ status: "ok" });
  if (!authorized(request, env, url)) return json({ error: "unauthorized" }, 401);
  try {
    if (path === "/api/reviews" && request.method === "POST") return await create(request, env);
    const match = path.match(/^\/api\/reviews\/([a-z0-9][a-z0-9_-]{0,63})\/(state|resolve|complete|frame)$/); if (!match) return json({ error: "not found" }, 404);
    const [, id, action] = match;
    if (action === "state" && request.method === "GET") { const session = await load(env, id); return session ? json({ workspace: "adjudicator-c", ...session, result_url: `/results/${id}.json` }) : json({ error: "review not found" }, 404); }
    if (action === "frame" && request.method === "GET") { const session = await load(env, id); if (!session) return json({ error: "review not found" }, 404); const source = url.searchParams.get("source") ?? "", filename = url.searchParams.get("filename") ?? ""; findFrame(session.merged, source, filename); const frameUrl = session.frame_urls[`${source}/${filename}`]; return frameUrl ? Response.redirect(frameUrl, 302) : json({ error: "frame URL not configured" }, 404); }
    if ((action === "resolve" || action === "complete") && request.method === "POST") return await mutate(request, env, id, action);
    return json({ error: "method not allowed" }, 405);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "invalid request" }, 400); }
} } satisfies ExportedHandler<AdjudicationEnv>;
