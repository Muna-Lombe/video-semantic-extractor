/** @type test @purpose Retain registered evidence and active uploads during audited orphan reclamation. */
import { describe, it, expect } from "vitest";
import { environment, call, frameSet } from "./registry-test-support";
const path = "/operations/orphans";
async function oldObject(env, key) {
  await env.INTERNAL_ARTIFACTS_BUCKET.put(key, "orphan");
  env.INTERNAL_ARTIFACTS_BUCKET.objects.get(key).uploaded = new Date(Date.now() - 8 * 86400000);
  const object = await env.INTERNAL_ARTIFACTS_BUCKET.head(key);
  return { key, etag: object.etag };
}
describe("storage retention and operational health", () => {
  it("previews and deletes old orphans, with a tombstone and audit trail, retaining current and registered objects", async () => {
    const env = environment(); await frameSet(env);
    const orphan = await oldObject(env, "evaluations/evaluation_lost/report.json");
    await oldObject(env, "unknown/path.json");
    await env.INTERNAL_ARTIFACTS_BUCKET.put("models/mv_new/new.onnx", "new");
    const preview = await (await call(env, path)).json();
    expect(preview.data).toEqual([expect.objectContaining(orphan)]);
    const result = await (await call(env, path, "POST", { objects: [orphan], reason: "Reclaim interrupted evaluation output" })).json();
    expect(result.data.deleted).toEqual([orphan.key]);
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head("frame.jpg")).not.toBeNull();
    expect(await env.INTERNAL_ARTIFACTS_BUCKET.head("models/mv_new/new.onnx")).not.toBeNull();
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS count FROM internal_audit_events WHERE action = 'artifact.orphan_deleted'").get().count).toBe(1);
    expect(() => env.CONTROL_DB.db.prepare("INSERT INTO artifacts (id,kind,storage_key,sha256,created_at) VALUES ('a_deleted','evaluation_report',?,'hash','now')").run(orphan.key)).toThrow(/tombstoned/);
    expect((await call(env, "/operations")).status).toBe(200);
  });
  it("rechecks references and etags after preview and protects queued/running upload ownership", async () => {
    const env = environment(); await frameSet(env);
    const adopted = await oldObject(env, "models/mv_adopted/model.onnx");
    const changed = await oldObject(env, "models/mv_changed/model.onnx");
    const busy = await oldObject(env, "sampling/job_busy/frames/frame.jpg");
    env.CONTROL_DB.db.prepare("INSERT INTO internal_jobs (id,job_type,status,input_json,created_at,updated_at) VALUES ('job_busy','sampling','queued','{}','now','now')").run();
    env.CONTROL_DB.db.prepare("INSERT INTO artifact_uploads (id,sampling_job_id,lease_token_hash,kind,storage_key,sha256,size_bytes,media_type,created_at) VALUES ('upload_test','job_busy','hash','frame_image',?,'hash',6,'image/jpeg','now')").run(busy.key);
    env.CONTROL_DB.db.prepare("INSERT INTO artifacts (id,kind,storage_key,sha256,created_at) VALUES ('adopted','model',?,'hash','now')").run(adopted.key);
    await env.INTERNAL_ARTIFACTS_BUCKET.put(changed.key, "replaced");
    const result = await (await call(env, path, "POST", { objects: [adopted, changed, busy], reason: "old preview" })).json();
    expect(result.data.deleted).toEqual([]);
    expect(result.data.skipped).toHaveLength(3);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS count FROM artifact_tombstones").get().count).toBe(0);
  });
});
