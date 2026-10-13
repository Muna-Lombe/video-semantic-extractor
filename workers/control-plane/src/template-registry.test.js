/** @type test @purpose Exercise registry routes with actual SQLite and private artifact storage. */
import { describe, expect, it } from "vitest";
import { handleInternalsApi } from "./internals";
import { sha256Hex } from "./artifact-pipeline";
import { ANNOTATION_SCHEMA_VERSION } from "./template-registry";
import { environment, request, call, policy, frameSet, templateInput, policyInput } from "./registry-test-support";

describe("managed policy and template registry", () => {
  it("registers immutable policy versions, paginates, and audits only real creations", async () => {
    const env = environment(), registered = await policy(env);
    expect(registered).toMatchObject({ status: "active", annotation_schema_version: ANNOTATION_SCHEMA_VERSION, document: policyInput.document });
    expect(registered.sha256).toMatch(/^[a-f0-9]{64}$/);
    const duplicate = await call(env, "/policies", "POST", policyInput);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).data.id).toBe(registered.id);
    const conflict = await call(env, "/policies", "POST", { ...policyInput, document: "Changed instructions" });
    expect(conflict.status).toBe(409);
    const next = await policy(env, { ...policyInput, version: "2026-10-13" });
    expect(next.policy_id).toBe(registered.policy_id);
    const listed = await (await call(env, "/policies?limit=1")).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.pagination).toMatchObject({ has_more: true, next_offset: 1 });
    expect(listed.data[0]).not.toHaveProperty("document");
    expect((await (await call(env, `/policies/${registered.id}`)).json()).data.document).toBe(policyInput.document);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events").get().n).toBe(2);
  });

  it("generates and retrieves a deterministic template with frozen provenance and incomplete review", async () => {
    const env = environment(), registered = await policy(env);
    const manifest = await frameSet(env);
    const created = await call(env, "/templates", "POST", templateInput(registered.id));
    expect(created.status).toBe(201);
    const template = (await created.json()).data;
    const download = await call(env, `/templates/${template.id}/artifact`);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    const content = await download.text(), initialized = JSON.parse(content);
    expect(await sha256Hex(content)).toBe(template.sha256);
    expect(initialized.provenance).toMatchObject({ policy_version_id: registered.id, policy_sha256: registered.sha256, frame_set_id: manifest.frame_set_id });
    expect(initialized.review).toMatchObject({ independent_passes: 0, predictions_reviewed_before_freeze: false, reviewed_frames: [], adjudication_status: "not_started" });
    expect(initialized.sources[0]).toMatchObject({ source: "src_test", source_sha256: "b".repeat(64) });
    expect(initialized.sources[0].frames[0]).toMatchObject({ filename: "frame_test.jpg", frame_id: "frame_test", timestamp_sec: 0, objects: [], out_of_taxonomy: [] });
    const repeated = await call(env, "/templates", "POST", templateInput(registered.id));
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).data.id).toBe(template.id);
    expect((await (await call(env, "/templates")).json()).data).toHaveLength(1);
    expect((await (await call(env, `/templates/${template.id}`)).json()).data.sha256).toBe(template.sha256);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action = 'template.generate'").get().n).toBe(1);
  });

  it.each(["/policies", "/templates", "/policies/pv_test", "/templates/tpl_test/artifact"])("guards %s before database or storage access", async (path) => {
    const response = await call({ ADMIN_TOKEN: "test-admin" }, path, "GET", undefined, "wrong");
    expect(response.status).toBe(401);
  });

  it("rejects unsupported schemas, unknown fields, malformed JSON, oversize documents, and unsafe pagination", async () => {
    const env = environment();
    expect((await call(env, "/policies", "POST", { ...policyInput, annotation_schema_version: "unknown" })).status).toBe(422);
    expect((await call(env, "/policies", "POST", { ...policyInput, predictions: [] })).status).toBe(400);
    expect((await call(env, "/policies", "POST", { ...policyInput, document: "x".repeat(48001) })).status).toBe(400);
    expect((await call(env, "/policies?offset=9007199254740992")).status).toBe(400);
    expect((await call(env, "/templates?limit=0")).status).toBe(400);
    const malformed = new Request("https://internal.test/api/internal/v1/policies", { method: "POST", headers: { authorization: "Bearer test-admin", "content-type": "application/json" }, body: "{" });
    expect((await handleInternalsApi(malformed, env)).status).toBe(400);
    expect((await call(env, "/policies/pv_missing")).status).toBe(404);
    expect((await call(env, "/templates/tpl_missing/artifact")).status).toBe(404);
    expect((await call(env, "/templates", "POST", templateInput("pv_missing"))).status).toBe(404);
    expect((await call(env, "/policies", "DELETE")).status).toBe(405);
  });

  it.each([
    ["missing evidence", (env) => env.INTERNAL_ARTIFACTS_BUCKET.objects.delete("frame.jpg"), "evidence_unavailable"],
    ["wrong evidence metadata", (env) => { env.INTERNAL_ARTIFACTS_BUCKET.objects.get("frame.jpg").customMetadata.sha256 = "c".repeat(64); }, "evidence_unavailable"],
    ["changed source checksum", (env) => env.CONTROL_DB.db.exec("UPDATE frame_set_sources SET source_sha256 = 'wrong'"), "source_mismatch"],
    ["changed frame timestamp", (env) => env.CONTROL_DB.db.exec("UPDATE frame_set_frames SET timestamp_seconds = 1"), "evidence_mismatch"],
    ["changed sampling reasons", (env) => env.CONTROL_DB.db.exec("UPDATE frame_set_frames SET reasons_json = '[\"interval\"]'"), "evidence_mismatch"],
    ["changed manifest bytes", (env) => { env.INTERNAL_ARTIFACTS_BUCKET.objects.get("manifest.json").bytes[20] = 120; }, "manifest_verification_failed"],
    ["changed policy definition", (env) => env.CONTROL_DB.db.exec("UPDATE policy_versions SET definition_json = '{}'"), "incompatible_policy"],
    ["changed policy checksum", (env) => env.CONTROL_DB.db.exec("UPDATE policy_versions SET sha256 = 'wrong'"), "policy_verification_failed"],
  ])("rejects %s without registering a template", async (_label, damage, expectedCode) => {
    const env = environment(), registered = await policy(env);
    await frameSet(env); damage(env);
    const response = await call(env, "/templates", "POST", templateInput(registered.id));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe(expectedCode);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM templates").get().n).toBe(0);
  });

  it("requires ready inputs and rejects a modified stored template", async () => {
    const env = environment(), registered = await policy(env);
    await frameSet(env);
    env.CONTROL_DB.db.exec("UPDATE policy_versions SET status = 'draft'");
    expect((await call(env, "/templates", "POST", templateInput(registered.id))).status).toBe(409);
    env.CONTROL_DB.db.exec("UPDATE policy_versions SET status = 'active'; UPDATE frame_sets SET status = 'archived'");
    expect((await call(env, "/templates", "POST", templateInput(registered.id))).status).toBe(409);
    env.CONTROL_DB.db.exec("UPDATE frame_sets SET status = 'ready'");
    const created = (await (await call(env, "/templates", "POST", templateInput(registered.id))).json()).data;
    const reference = env.CONTROL_DB.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(created.artifact_id);
    env.INTERNAL_ARTIFACTS_BUCKET.objects.get(reference.storage_key).bytes[0] = 120;
    expect((await call(env, `/templates/${created.id}/artifact`)).status).toBe(422);
  });

  it("bounds synchronous generation before reading large artifacts", async () => {
    const env = environment(), registered = await policy(env);
    await frameSet(env);
    env.CONTROL_DB.db.exec("UPDATE frame_sets SET frame_count = 501");
    const response = await call(env, "/templates", "POST", templateInput(registered.id));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("generation_limit");
  });

  it("deduplicates concurrent policy registration while preserving immutable definitions", async () => {
    const env = environment();
    const responses = await Promise.all([call(env, "/policies", "POST", policyInput), call(env, "/policies", "POST", policyInput)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM policy_versions").get().n).toBe(1);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events").get().n).toBe(1);
  });

  it("deduplicates concurrent generation without deleting the winning artifact", async () => {
    const env = environment(), registered = await policy(env);
    await frameSet(env);
    const responses = await Promise.all([call(env, "/templates", "POST", templateInput(registered.id)), call(env, "/templates", "POST", templateInput(registered.id))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results[0].data.id).toBe(results[1].data.id);
    expect((await call(env, `/templates/${results[0].data.id}/artifact`)).status).toBe(200);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM templates").get().n).toBe(1);
  });

  it("rolls back metadata and audit entries if template registration fails", async () => {
    const env = environment(), registered = await policy(env);
    await frameSet(env);
    env.CONTROL_DB.db.exec("CREATE TRIGGER reject_template BEFORE INSERT ON templates BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    await expect(call(env, "/templates", "POST", templateInput(registered.id))).rejects.toThrow("test failure");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'template'").get().n).toBe(0);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action = 'template.generate'").get().n).toBe(0);
  });
});
