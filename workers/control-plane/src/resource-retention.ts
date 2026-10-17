/** @type implementation @purpose Archive inactive resource lineage before bounded, retryable payload removal. */
import type { AdjudicationEnv } from "./types";
import { sha256Hex } from "./artifact-pipeline";
import type { InternalActor } from "./internal-auth";

type Row = Record<string, any>;
type Kind = "frame_set" | "model_version";
const BASE = "/api/internal/v1/operations/retention";
const DAY = 86400000;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const activeArchive = "NOT EXISTS (SELECT 1 FROM resource_archives z WHERE z.resource_type=? AND z.resource_id=r.id AND z.state!='cancelled')";

// These predicates are used inside the same SQLite transaction that fences new references.
function eligible(kind: Kind) {
  const pinned = `NOT EXISTS (SELECT 1 FROM retention_pins p WHERE p.resource_type='${kind}' AND p.resource_id=r.id)`;
  if (kind === "model_version") return `${pinned} AND r.status IN ('rejected','retired') AND r.created_at<=?
    AND NOT EXISTS (SELECT 1 FROM internal_audit_events e WHERE e.resource_type='model_version' AND e.resource_id=r.id AND e.created_at>?)
    AND NOT EXISTS (SELECT 1 FROM evaluation_runs e JOIN internal_jobs j ON j.id=e.job_id WHERE e.model_version_id=r.id AND (j.status IN ('queued','running','succeeded') OR EXISTS (SELECT 1 FROM pipeline_release_evaluations x WHERE x.evaluation_run_id=e.id)))
    AND NOT EXISTS (SELECT 1 FROM pipeline_releases p WHERE json_extract(p.configuration_json,'$.model_version_id')=r.id AND p.status NOT IN ('superseded','rolled_back') AND p.approval_status!='rejected')`;
  return `${pinned} AND r.created_at<=? AND r.status IN ('ready','invalid','archived')
    AND NOT EXISTS (SELECT 1 FROM frame_set_frames f JOIN frame_set_frames shared ON shared.artifact_id=f.artifact_id AND shared.frame_set_id!=f.frame_set_id WHERE f.frame_set_id=r.id)
    AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.frame_set_id=r.id AND t.created_at>?)
    AND NOT EXISTS (SELECT 1 FROM templates t JOIN review_campaigns c ON c.template_id=t.id WHERE t.frame_set_id=r.id AND
      (EXISTS (SELECT 1 FROM ground_truth_versions g WHERE g.campaign_id=c.id AND
        (g.approval_status NOT IN ('rejected','superseded') OR EXISTS (SELECT 1 FROM ground_truth_decisions d WHERE d.ground_truth_id=g.id AND d.created_at>?) OR
          EXISTS (SELECT 1 FROM evaluation_runs e JOIN internal_jobs j ON j.id=e.job_id WHERE e.ground_truth_version_id=g.id AND (j.status IN ('queued','running','succeeded') OR EXISTS (SELECT 1 FROM pipeline_release_evaluations x WHERE x.evaluation_run_id=e.id)))))
       OR (c.status NOT IN ('completed','cancelled') AND (c.updated_at>? OR NOT EXISTS (SELECT 1 FROM campaign_assignments a WHERE a.campaign_id=c.id) OR EXISTS (SELECT 1 FROM campaign_assignments a WHERE a.campaign_id=c.id AND a.revoked_at IS NULL AND a.expires_at>?)))))`;
}
function args(kind: Kind, cutoff: string, now: string) { return kind === "frame_set" ? [cutoff, cutoff, cutoff, cutoff, now] : [cutoff, cutoff]; }
const table = (kind: Kind) => kind === "frame_set" ? "frame_sets" : "model_versions";
async function settings(env: AdjudicationEnv) { return (await env.CONTROL_DB.prepare("SELECT * FROM retention_settings WHERE id=1").first<Row>())!; }
async function payloads(env: AdjudicationEnv, kind: Kind, id: string): Promise<Row[]> {
  const sql = kind === "frame_set"
    ? "SELECT DISTINCT a.* FROM artifacts a JOIN frame_set_frames f ON f.artifact_id=a.id WHERE f.frame_set_id=? ORDER BY a.id"
    : "SELECT a.* FROM artifacts a JOIN model_versions m ON m.artifact_id=a.id WHERE m.id=?";
  return (await env.CONTROL_DB.prepare(sql).bind(id).all<Row>()).results;
}
export async function retentionPreview(env: AdjudicationEnv) {
  const policy = await settings(env), now = new Date().toISOString(), cutoff = new Date(Date.now() - policy.stale_days * DAY).toISOString();
  const candidates: Row[] = [];
  for (const kind of ["frame_set", "model_version"] as Kind[]) {
    const rows = await env.CONTROL_DB.prepare(`SELECT r.id,r.status,r.created_at FROM ${table(kind)} r WHERE ${activeArchive} AND ${eligible(kind)} ORDER BY r.created_at,r.id LIMIT 20`)
      .bind(kind, ...args(kind, cutoff, now)).all<Row>();
    for (const row of rows.results) {
      const artifacts = await payloads(env, kind, row.id);
      candidates.push({ resource_type: kind, ...row, payload_count: artifacts.length, reclaimable_bytes: artifacts.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0) });
    }
  }
  return { policy: { stale_days: policy.stale_days, grace_days: policy.grace_days, orphan_days: 7 }, candidates, meta: { dry_run: true, per_type_limit: 20, protected: "Active work, pending/approved ground truth, retained evaluations/releases, and explicit pins. Compact annotations and audit evidence are retained." } };
}

export async function archiveResource(env: AdjudicationEnv, kind: Kind, id: string, reason: string, actorId: string | null = null) {
  const policy = await settings(env), now = new Date().toISOString(), cutoff = new Date(Date.now() - policy.stale_days * DAY).toISOString();
  const resource = await env.CONTROL_DB.prepare(`SELECT r.* FROM ${table(kind)} r WHERE r.id=? AND ${activeArchive} AND ${eligible(kind)}`)
    .bind(id, kind, ...args(kind, cutoff, now)).first<Row>();
  if (!resource) return { skipped: id, reason: "Resource is protected, recent, or already archived." };
  const artifacts = await payloads(env, kind, id);
  const objects: Row[] = [];
  for (const artifact of artifacts) {
    const object = await env.INTERNAL_ARTIFACTS_BUCKET.get(artifact.storage_key);
    if (!object || object.size !== Number(artifact.size_bytes) || object.size > 16 * 1024 * 1024 || await sha256Hex(await object.arrayBuffer()) !== artifact.sha256) throw new Error("Payload missing, changed or outside archive verification budget; investigate before reclamation.");
    objects.push({ ...artifact, etag: object.etag });
  }
  const lineage: Row = {};
  if (kind === "frame_set") {
    lineage.sources = (await env.CONTROL_DB.prepare("SELECT * FROM frame_set_sources WHERE frame_set_id=? ORDER BY ordinal").bind(id).all()).results;
    lineage.templates = (await env.CONTROL_DB.prepare("SELECT id,policy_version_id,artifact_id,sha256,status FROM templates WHERE frame_set_id=?").bind(id).all()).results;
    lineage.campaigns = (await env.CONTROL_DB.prepare("SELECT c.id,c.status,c.template_id,c.completed_at FROM review_campaigns c JOIN templates t ON t.id=c.template_id WHERE t.frame_set_id=?").bind(id).all()).results;
    lineage.ground_truth = (await env.CONTROL_DB.prepare("SELECT g.* FROM ground_truth_versions g JOIN review_campaigns c ON c.id=g.campaign_id JOIN templates t ON t.id=c.template_id WHERE t.frame_set_id=?").bind(id).all()).results;
  }
  const archiveId = `archive_${crypto.randomUUID().replaceAll("-", "")}`;
  const snapshot = JSON.stringify({ schema_version: "resource-archive.v1", resource_type: kind, resource, lineage, payloads: objects, policy: { stale_days: policy.stale_days, grace_days: policy.grace_days }, retained: "Source/frame manifests, policy definitions, annotations, submissions, comparisons, decisions, validation and evaluation reports remain in their original records. Media payloads cannot be replayed after deletion without verified originals." });
  const sha = await sha256Hex(snapshot), key = `archives/${archiveId}/${sha}.json`;
  await env.INTERNAL_ARTIFACTS_BUCKET.put(key, snapshot, { httpMetadata: { contentType: "application/json" }, customMetadata: { sha256: sha } });
  const written = await env.INTERNAL_ARTIFACTS_BUCKET.get(key);
  if (!written || await sha256Hex(await written.arrayBuffer()) !== sha) throw new Error("Archive verification failed; payloads retained.");
  const deleteAfter = new Date(Date.now() + policy.grace_days * DAY).toISOString();
  try {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(`INSERT INTO resource_archives (id,resource_type,resource_id,snapshot_json,snapshot_sha256,storage_key,state,reason,created_at,delete_after)
        SELECT ?,?,?,?,?,?,'scheduled',?,?,? FROM ${table(kind)} r WHERE r.id=? AND ${activeArchive} AND ${eligible(kind)}`)
        .bind(archiveId, kind, id, snapshot, sha, key, reason, now, deleteAfter, id, kind, ...args(kind, cutoff, now)),
      env.CONTROL_DB.prepare("INSERT INTO governance_assertions(valid) SELECT EXISTS(SELECT 1 FROM resource_archives WHERE id=?)").bind(archiveId),
      ...objects.map((item) => env.CONTROL_DB.prepare("INSERT INTO artifact_retirements(artifact_id,archive_id,etag) VALUES (?,?,?)").bind(item.id, archiveId, item.etag)),
      ...(kind === "frame_set" ? [env.CONTROL_DB.prepare("UPDATE frame_sets SET status='archived' WHERE id=?").bind(id), env.CONTROL_DB.prepare("UPDATE review_campaigns SET status='cancelled' WHERE template_id IN (SELECT id FROM templates WHERE frame_set_id=?) AND status NOT IN ('completed','cancelled')").bind(id)] : []),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'resource.archived',?,?,?,?)")
        .bind(actorId, kind, id, JSON.stringify({ archive_id: archiveId, sha256: sha, reason, delete_after: deleteAfter }), now),
    ]);
  } catch (cause) { await env.INTERNAL_ARTIFACTS_BUCKET.delete(key); throw cause; }
  return { id: archiveId, resource_id: id, state: "scheduled", delete_after: deleteAfter, payload_count: objects.length };
}

export async function purgeArchives(env: AdjudicationEnv, limit = 25) {
  const now = new Date().toISOString();
  const entries = (await env.CONTROL_DB.prepare("SELECT * FROM resource_archives WHERE state IN ('scheduled','deleting') AND delete_after<=? ORDER BY delete_after LIMIT 10").bind(now).all<Row>()).results;
  const result = { deleted_objects: 0, reclaimed_bytes: 0, errors: [] as string[] };
  for (const archive of entries) {
    if (result.deleted_objects >= limit) break;
    let ownedToken: string | null = null;
    try {
      // New consumers and pins are fenced by triggers once the archive is scheduled.
      const token = crypto.randomUUID(), leaseUntil = new Date(Date.now() + 300000).toISOString();
      ownedToken = token;
      const claimed = await env.CONTROL_DB.prepare("UPDATE resource_archives SET state='deleting',last_error=NULL,purge_lease_token=?,purge_lease_until=? WHERE id=? AND state IN ('scheduled','deleting') AND (purge_lease_until IS NULL OR purge_lease_until<=?) RETURNING id").bind(token, leaseUntil, archive.id, now).first();
      if (!claimed) continue;
      const stored = await env.INTERNAL_ARTIFACTS_BUCKET.get(archive.storage_key);
      if (!stored || await sha256Hex(await stored.arrayBuffer()) !== archive.snapshot_sha256) throw new Error("Archive missing or changed; deletion stopped.");
      const objects = (await env.CONTROL_DB.prepare("SELECT a.*,r.etag FROM artifact_retirements r JOIN artifacts a ON a.id=r.artifact_id WHERE r.archive_id=? AND r.deleted_at IS NULL ORDER BY a.id LIMIT ?").bind(archive.id, limit - result.deleted_objects).all<Row>()).results;
      for (const item of objects) {
        const stillOwned = await env.CONTROL_DB.prepare("SELECT id FROM resource_archives WHERE id=? AND purge_lease_token=? AND purge_lease_until>?").bind(archive.id, token, new Date().toISOString()).first();
        if (!stillOwned) throw new Error("Reclamation lease expired; another sweep can resume.");
        const current = await env.INTERNAL_ARTIFACTS_BUCKET.head(item.storage_key);
        if (current && (current.etag !== item.etag || current.size !== Number(item.size_bytes))) throw new Error("Payload changed after archive; deletion stopped.");
        await env.INTERNAL_ARTIFACTS_BUCKET.delete(item.storage_key);
        await env.CONTROL_DB.batch([
          env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(action,resource_type,resource_id,details_json,created_at) SELECT 'artifact.payload_deleted','artifact',?,?,? WHERE EXISTS(SELECT 1 FROM artifact_retirements WHERE artifact_id=? AND deleted_at IS NULL)").bind(item.id, JSON.stringify({ archive_id: archive.id, size_bytes: item.size_bytes, sha256: item.sha256 }), now, item.id),
          env.CONTROL_DB.prepare("UPDATE artifact_retirements SET deleted_at=? WHERE artifact_id=? AND deleted_at IS NULL").bind(now, item.id),
        ]);
        result.deleted_objects++;
        if (current) result.reclaimed_bytes += Number(item.size_bytes || 0);
      }
      await env.CONTROL_DB.prepare("UPDATE resource_archives SET state='deleted',completed_at=?,last_error=NULL WHERE id=? AND NOT EXISTS (SELECT 1 FROM artifact_retirements WHERE archive_id=? AND deleted_at IS NULL)").bind(now, archive.id, archive.id).run();
      await env.CONTROL_DB.prepare("UPDATE resource_archives SET purge_lease_token=NULL,purge_lease_until=NULL WHERE id=? AND purge_lease_token=?").bind(archive.id, token).run();
    } catch (cause) {
      const message = (cause as Error).message;
      await env.CONTROL_DB.prepare("UPDATE resource_archives SET last_error=?,purge_lease_token=NULL,purge_lease_until=NULL WHERE id=? AND purge_lease_token=?").bind(message, archive.id, ownedToken).run();
      result.errors.push(`${archive.id}: ${message}`);
    }
  }
  return result;
}
export async function runRetention(env: AdjudicationEnv) {
  const preview = await retentionPreview(env);
  const archived = [];
  let verificationBudget = 500;
  for (const item of preview.candidates.slice(0, 5)) {
    if (item.payload_count > verificationBudget) continue;
    verificationBudget -= item.payload_count;
    try { archived.push(await archiveResource(env, item.resource_type as Kind, item.id, "Scheduled retention: stale, unpinned resource without retained consumers.")); }
    catch (cause) { archived.push({ resource_id: item.id, error: (cause as Error).message }); }
  }
  return { archived, purged: await purgeArchives(env), expired_identity: await pruneExpiredIdentity(env) };
}

/** Keep an archival event for expired credentials without retaining their token hashes. */
export async function pruneExpiredIdentity(env: AdjudicationEnv) {
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - 7 * DAY).toISOString();
  const counts: Row = {};
  for (const [name, predicate, fields] of [
    ["internal_sessions", "expires_at<=?", "'id',id,'user_id',user_id,'created_at',created_at,'expires_at',expires_at,'last_seen_at',last_seen_at,'revoked_at',revoked_at"],
    ["internal_auth_challenges", "expires_at<=? AND NOT EXISTS(SELECT 1 FROM internal_sessions s WHERE s.id=internal_auth_challenges.consumed_by_session_id AND s.expires_at>?)", "'id',id,'user_id',user_id,'purpose',purpose,'created_at',created_at,'expires_at',expires_at,'consumed_at',consumed_at"],
  ]) {
    const args = name === "internal_sessions" ? [cutoff] : [cutoff, now];
    const selected = `SELECT * FROM ${name} WHERE ${predicate} ORDER BY expires_at,id LIMIT 100`;
    const batch = await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(`INSERT INTO internal_audit_events(action,resource_type,resource_id,details_json,created_at)
        SELECT 'identity.expired_resources_archived',?,?,json_group_array(json_object(${fields})),? FROM (${selected}) HAVING COUNT(*)>0`)
        .bind(name, `expiry_${crypto.randomUUID()}`, now, ...args),
      env.CONTROL_DB.prepare(`DELETE FROM ${name} WHERE id IN (SELECT id FROM (${selected}))`).bind(...args),
    ]);
    counts[name] = batch[1].meta?.changes ?? 0;
  }
  return counts;
}

export async function handleRetention(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
  if (request.method === "GET") {
    if (path === BASE) return json({ data: await retentionPreview(env) });
    if (path === `${BASE}/archives`) return json({ data: (await env.CONTROL_DB.prepare("SELECT id,resource_type,resource_id,state,reason,created_at,delete_after,completed_at,last_error FROM resource_archives ORDER BY created_at DESC LIMIT 100").all()).results });
    if (path === `${BASE}/pins`) return json({ data: (await env.CONTROL_DB.prepare("SELECT * FROM retention_pins ORDER BY created_at DESC LIMIT 100").all()).results });
    const archiveMatch = path.match(/\/archives\/(archive_[a-z0-9]+)$/);
    if (archiveMatch) {
      const archive = await env.CONTROL_DB.prepare("SELECT * FROM resource_archives WHERE id=?").bind(archiveMatch[1]).first<Row>();
      return archive ? json({ data: { ...archive, snapshot: JSON.parse(archive.snapshot_json) } }) : json({ error: { message: "archive not found" } }, 404);
    }
  }
  if (!["POST", "PUT", "DELETE"].includes(request.method)) return json({ error: { message: "method not allowed" } }, 405);
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return json({ error: { message: "content-type must be application/json" } }, 415);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8192) return json({ error: { message: "request too large" } }, 413);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
    const actorId = actor.kind === "user" ? actor.user.id : null;
    if (path === `${BASE}/settings` && request.method === "PUT") {
      if (Object.keys(value).some((key) => !["stale_days", "grace_days"].includes(key)) || !Number.isInteger(value.stale_days) || value.stale_days < 7 || value.stale_days > 365 || !Number.isInteger(value.grace_days) || value.grace_days < 1 || value.grace_days > 90) throw new Error("stale_days must be 7–365; grace_days must be 1–90");
      await env.CONTROL_DB.batch([env.CONTROL_DB.prepare("UPDATE retention_settings SET stale_days=?,grace_days=? WHERE id=1").bind(value.stale_days, value.grace_days), env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'retention.settings','retention','default',?,?)").bind(actorId, text, new Date().toISOString())]);
      return json({ data: value });
    }
    const cancel = path.match(/\/archives\/(archive_[a-z0-9]+)\/cancel$/);
    if (cancel && request.method === "POST") {
      const archive = await env.CONTROL_DB.prepare("SELECT * FROM resource_archives WHERE id=? AND state='scheduled'").bind(cancel[1]).first<Row>();
      if (!archive) return json({ error: { message: "only scheduled archives can be cancelled" } }, 409);
      const original = JSON.parse(archive.snapshot_json).resource;
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare("UPDATE resource_archives SET state='cancelled' WHERE id=? AND state='scheduled'").bind(archive.id),
        env.CONTROL_DB.prepare("INSERT INTO governance_assertions(valid) SELECT EXISTS(SELECT 1 FROM resource_archives WHERE id=? AND state='cancelled')").bind(archive.id),
        env.CONTROL_DB.prepare("DELETE FROM artifact_retirements WHERE archive_id=?").bind(archive.id),
        ...(archive.resource_type === "frame_set" ? [env.CONTROL_DB.prepare("UPDATE frame_sets SET status=? WHERE id=?").bind(original.status, archive.resource_id)] : []),
        ...(archive.resource_type === "frame_set" ? JSON.parse(archive.snapshot_json).lineage.campaigns.map((campaign: Row) => env.CONTROL_DB.prepare("UPDATE review_campaigns SET status=? WHERE id=? AND status='cancelled'").bind(campaign.status, campaign.id)) : []),
        env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'resource.archive_cancelled',?,?,?,?)").bind(actorId, archive.resource_type, archive.resource_id, JSON.stringify({ archive_id: archive.id }), new Date().toISOString()),
      ]);
      return json({ data: { id: archive.id, state: "cancelled" } });
    }
    if (!["frame_set", "model_version"].includes(value.resource_type) || typeof value.resource_id !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(value.resource_id)) throw new Error("resource_type and resource_id are required");
    if (path === `${BASE}/pins` && request.method === "DELETE") {
      await env.CONTROL_DB.batch([env.CONTROL_DB.prepare("DELETE FROM retention_pins WHERE resource_type=? AND resource_id=?").bind(value.resource_type, value.resource_id), env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'retention.unpinned',?,?,?,?)").bind(actorId, value.resource_type, value.resource_id, "{}", new Date().toISOString())]);
      return json({ data: { unpinned: true } });
    }
    if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000) throw new Error("a reason (1–2000 characters) is required");
    if (path === `${BASE}/pins` && request.method === "POST") {
      const exists = await env.CONTROL_DB.prepare(`SELECT id FROM ${table(value.resource_type)} WHERE id=?`).bind(value.resource_id).first();
      if (!exists) return json({ error: { message: "resource not found" } }, 404);
      await env.CONTROL_DB.batch([env.CONTROL_DB.prepare("INSERT INTO retention_pins(resource_type,resource_id,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(resource_type,resource_id) DO UPDATE SET reason=excluded.reason").bind(value.resource_type, value.resource_id, value.reason, new Date().toISOString()), env.CONTROL_DB.prepare("INSERT INTO internal_audit_events(actor_user_id,action,resource_type,resource_id,details_json,created_at) VALUES (?,'retention.pinned',?,?,?,?)").bind(actorId, value.resource_type, value.resource_id, JSON.stringify({ reason: value.reason }), new Date().toISOString())]);
      return json({ data: { pinned: true } });
    }
    if (path === `${BASE}/archive` && request.method === "POST") return json({ data: await archiveResource(env, value.resource_type, value.resource_id, value.reason, actorId) });
    return json({ error: { message: "not found" } }, 404);
  } catch (cause) { return json({ error: { message: (cause as Error).message } }, 400); }
}
