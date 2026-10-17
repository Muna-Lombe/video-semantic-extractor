/** @type implementation @purpose Inspect operational health and safely reclaim unregistered old objects. */
import type { AdjudicationEnv } from "./types";
import type { InternalActor } from "./internal-auth";
import { handleRetention } from "./resource-retention";
type Row = Record<string, any>;
const BASE = "/api/internal/v1/operations";
const AGE_MS = 7 * 24 * 60 * 60 * 1000;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const references = `NOT EXISTS (SELECT 1 FROM artifacts WHERE storage_key = ?)
  AND NOT EXISTS (SELECT 1 FROM ground_truth_validations WHERE report_storage_key = ?)
  AND NOT EXISTS (SELECT 1 FROM resource_archives WHERE storage_key = ?)
  AND NOT EXISTS (SELECT 1 FROM artifact_uploads u JOIN internal_jobs j ON j.id = u.sampling_job_id
    WHERE u.storage_key = ? AND (u.status = 'finalized' OR j.status IN ('queued','running')))`;
async function unreferenced(env: AdjudicationEnv, key: string) {
  return Boolean(await env.CONTROL_DB.prepare(`SELECT 1 AS safe WHERE ${references}`).bind(key, key, key, key).first());
}
function ownedKey(key: string) { return /^(sampling|templates|ground-truth|campaigns|evaluations|models|archives)\/[a-zA-Z0-9_/-]+(?:\.[a-z0-9]+)?$/.test(key); }
export async function handleOperations(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
  const retention = await handleRetention(request, env, actor);
  if (retention) return retention;
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
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return json({ error: { message: "limit must be 1–100" } }, 400);
    const objects = await env.INTERNAL_ARTIFACTS_BUCKET.list({ limit: Number(rawLimit), ...(cursor ? { cursor } : {}) });
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
      .bind(selected.key, timestamp, selected.key, selected.key, selected.key, selected.key).first();
    if (!claim) { skipped.push(selected.key); continue; }
    await env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'artifact.orphan_deletion_scheduled','storage_object',?,?,?)")
      .bind(actor.kind === "user" ? actor.user.id : null, selected.key, JSON.stringify({ reason: value.reason, etag: selected.etag, size: object.size, sha256: object.customMetadata?.sha256 ?? null }), timestamp).run();
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

/** Bounded scheduled sweep; persisted cursor avoids rescanning only the first page. */
export async function sweepOrphans(env: AdjudicationEnv) {
  const state = await env.CONTROL_DB.prepare("SELECT cursor FROM retention_orphan_cursor WHERE id=1").first<{ cursor: string | null }>();
  const preview = await handleOperations(new Request(`https://internal.invalid${BASE}/orphans?limit=25${state?.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ""}`), env, { kind: "legacy_admin" });
  const value = await preview!.json() as { data: Row[]; pagination: { cursor: string | null } };
  await env.CONTROL_DB.prepare("UPDATE retention_orphan_cursor SET cursor=? WHERE id=1").bind(value.pagination.cursor).run();
  if (!value.data.length) return { deleted: [] };
  const response = await handleOperations(new Request(`https://internal.invalid${BASE}/orphans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objects: value.data.slice(0, 25).map(({ key, etag }) => ({ key, etag })), reason: "Scheduled retention of expired orphan uploads." }) }), env, { kind: "legacy_admin" });
  return response!.json();
}
