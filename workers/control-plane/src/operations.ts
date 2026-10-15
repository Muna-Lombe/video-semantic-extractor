/** @type implementation @purpose Inspect operational health and safely reclaim unregistered old objects. */
import type { AdjudicationEnv } from "./types";
import type { InternalActor } from "./internal-auth";
type Row = Record<string, any>;
const BASE = "/api/internal/v1/operations";
const AGE_MS = 7 * 24 * 60 * 60 * 1000;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const references = `NOT EXISTS (SELECT 1 FROM artifacts WHERE storage_key = ?)
  AND NOT EXISTS (SELECT 1 FROM ground_truth_validations WHERE report_storage_key = ?)
  AND NOT EXISTS (SELECT 1 FROM artifact_uploads u JOIN internal_jobs j ON j.id = u.sampling_job_id
    WHERE u.storage_key = ? AND (u.status = 'finalized' OR j.status IN ('queued','running')))`;
async function unreferenced(env: AdjudicationEnv, key: string) {
  return Boolean(await env.CONTROL_DB.prepare(`SELECT 1 AS safe WHERE ${references}`).bind(key, key, key).first());
}
function ownedKey(key: string) { return /^(sampling|templates|ground-truth|campaigns|evaluations|models)\/[a-zA-Z0-9_/-]+(?:\.[a-z0-9]+)?$/.test(key); }
export async function handleOperations(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
  if (path === BASE && request.method === "GET") {
    const [jobs, leases, artifacts, decisions] = await Promise.all([
      env.CONTROL_DB.prepare("SELECT job_type, status, COUNT(*) AS count FROM internal_jobs GROUP BY job_type, status").all(),
      env.CONTROL_DB.prepare("SELECT id, job_type, attempt_count, max_attempts, lease_expires_at, cancellation_requested_at FROM internal_jobs WHERE status = 'running' AND lease_expires_at <= ? ORDER BY lease_expires_at LIMIT 100").bind(new Date().toISOString()).all(),
      env.CONTROL_DB.prepare("SELECT kind, COUNT(*) AS count, SUM(size_bytes) AS size_bytes FROM artifacts GROUP BY kind").all(),
      env.CONTROL_DB.prepare("SELECT id, action, resource_type, resource_id, actor_user_id, created_at FROM internal_audit_events ORDER BY id DESC LIMIT 50").all(),
    ]);
    return json({ data: { jobs: jobs.results, expired_leases: leases.results, artifacts: artifacts.results, recent_events: decisions.results, retention: { registered_evidence: "retain", orphan_minimum_age_days: 7, mutable_review_bucket: "excluded" } } });
  }
  if (path !== `${BASE}/orphans`) return json({ error: { message: "not found" } }, 404);
  if (request.method === "GET") {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const objects = await env.INTERNAL_ARTIFACTS_BUCKET.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    const candidates = [];
    for (const object of objects.objects) if (ownedKey(object.key) && object.uploaded.getTime() < Date.now() - AGE_MS && await unreferenced(env, object.key)) candidates.push({ key: object.key, etag: object.etag, size: object.size, uploaded: object.uploaded.toISOString() });
    return json({ data: candidates, pagination: { cursor: objects.truncated ? objects.cursor : null, has_more: objects.truncated }, meta: { dry_run: true, minimum_age_days: 7 } });
  }
  if (request.method !== "POST") return json({ error: { message: "method not allowed" } }, 405);
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return json({ error: { message: "content-type must be application/json" } }, 415);
  const raw = await request.text();
  if (raw.length > 64 * 1024) return json({ error: { message: "request too large" } }, 413);
  let value: Row;
  try { value = JSON.parse(raw); } catch { return json({ error: { message: "invalid JSON" } }, 400); }
  if (!value || !Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > 100 || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000 || value.objects.some((object: Row) => !object || typeof object.key !== "string" || !ownedKey(object.key) || typeof object.etag !== "string")) return json({ error: { message: "provide 1-100 previewed objects with key/etag and a reason" } }, 400);
  const deleted = [], skipped = [];
  for (const selected of value.objects) {
    const object = await env.INTERNAL_ARTIFACTS_BUCKET.head(selected.key);
    if (!object || object.etag !== selected.etag || object.uploaded.getTime() >= Date.now() - AGE_MS) { skipped.push(selected.key); continue; }
    const timestamp = new Date().toISOString();
    // Prevent registration after the final reference check. Failed R2 deletion leaves a
    // tombstone that is safe to retry; it never makes evidence eligible for deletion.
    const claim = await env.CONTROL_DB.prepare(`INSERT INTO artifact_tombstones (storage_key, created_at)
      SELECT ?, ? WHERE ${references} ON CONFLICT(storage_key) DO UPDATE SET created_at = excluded.created_at RETURNING storage_key`)
      .bind(selected.key, timestamp, selected.key, selected.key, selected.key).first();
    if (!claim) { skipped.push(selected.key); continue; }
    await env.INTERNAL_ARTIFACTS_BUCKET.delete(selected.key);
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare("DELETE FROM artifact_uploads WHERE storage_key = ? AND status != 'finalized'").bind(selected.key),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'artifact.orphan_deleted', 'storage_object', ?, ?, ?)")
        .bind(actor.kind === "user" ? actor.user.id : null, selected.key, JSON.stringify({ reason: value.reason, etag: selected.etag, size: object.size }), timestamp),
    ]);
    deleted.push(selected.key);
  }
  return json({ data: { deleted, skipped } });
}
