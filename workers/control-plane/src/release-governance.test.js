/** @type test @purpose Exercise the real review-to-evaluation-to-release chain and governance failure gates. */
import { describe, expect, it } from "vitest";
import { candidate, approved } from "./ground-truth-test-support";
import { call, callWithHeaders } from "./campaign-test-support";
import { canAccessInternals } from "./internal-auth";
import { EVALUATION_IMPLEMENTATION_VERSION, SAMPLING_IMPLEMENTATION_VERSION } from "./engine-versions";
const base = "/api/internal/v1";
async function data(response, status = 200) {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload.data;
}
async function model(env, name = "Test NanoDet") {
  return data(await call(env, `${base}/models`, "POST", {
    name, version: "1.0", license: "Apache-2.0", provenance: { source: "fixture", implementation_version: "test-v1" },
    configuration: { architecture: "nanodet-plus-1.5x-416" }, model_base64: btoa("fixture ONNX; inference is mocked only in this API test"),
  }), 201);
}
async function run(env, truthId, modelId, release) {
  return data(await call(env, `${base}/evaluations`, "POST", { ground_truth_version_id: truthId, model_version_id: modelId, ...(release ? { pipeline_release_id: release.id } : {}), idempotency_key: crypto.randomUUID() }), 202);
}
async function complete(env, evaluation, f1 = 0.9) {
  env.RUNNER_TOKEN = "test-runner";
  const claim = await data(await call(env, `${base}/runner/evaluation-jobs/claim`, "POST", { runner_id: "test-runner", lease_seconds: 300 }, "test-runner"));
  expect(claim.job.id).toBe(evaluation.job_id);
  const headers = { authorization: "Bearer test-runner", "x-job-lease-token": claim.lease_token };
  const plan = await data(await callWithHeaders(env, `${base}/runner/evaluation-jobs/${evaluation.job_id}/inputs`, "GET", undefined, headers));
  const sources = {};
  const tp = Math.round(f1 * 10), fp = 10 - tp, fn = fp;
  for (const frame of plan.frames) {
    sources[frame.source_id] ??= { frames: [] };
    sources[frame.source_id].frames.push({ frame_id: frame.frame_id, artifact_sha256: frame.sha256, inference_ms: 10, score: { true_positives: tp, false_positives: fp, false_negatives: fn }, errors: { false_positive_observations: [], false_negative_labels: [] } });
  }
  const report = { schema_version: "managed-evaluation-report.v1", evaluation_run_id: evaluation.id, input_sha256: evaluation.input_sha256, implementation_version: evaluation.implementation_version, model_sha256: plan.model.sha256, ground_truth_sha256: plan.ground_truth.sha256, metrics: { frame_count: plan.frames.length, source_count: Object.keys(sources).length, true_positives: tp * plan.frames.length, false_positives: fp * plan.frames.length, false_negatives: fn * plan.frames.length, object_precision: f1, object_recall: f1, object_f1: f1, p95_inference_ms: 10, mean_inference_ms: 10, sources } };
  await data(await callWithHeaders(env, `${base}/runner/evaluation-jobs/${evaluation.job_id}/complete`, "POST", report, headers));
  return { report, headers };
}
async function decide(env, collection, item, action, body) {
  return call(env, `${base}/${collection}/${item.id}/${action}`, "POST", { reason: "Reviewed immutable diagnostic evidence", ...body }, "test-admin", item.revision);
}
async function release(env, modelId, version) {
  return data(await call(env, `${base}/releases`, "POST", {
    version, model_version_id: modelId,
    components: { sampler: SAMPLING_IMPLEMENTATION_VERSION, annotation_schema: "object-annotations.v1", evaluator: EVALUATION_IMPLEMENTATION_VERSION },
    thresholds: { minimum_confidence: 0.35, nms_threshold: 0.6, minimum_iou: 0.5 },
    acceptance: { minimum_f1: 0.8, maximum_p95_inference_ms: 100 },
  }), 201);
}
describe("evidence-backed model/release governance", () => {
  it("evaluates candidates, freezes reports, approves models/releases and atomically activates and rolls back", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    await approved(prepared);
    const mv = await model(env), evaluation = await run(env, truth.id, mv.id);
    await complete(env, evaluation);
    const reportResponse = await call(env, `${base}/evaluations/${evaluation.id}/report`);
    expect(reportResponse.status).toBe(200);
    expect((await reportResponse.json()).evaluation_run_id).toBe(evaluation.id);
    const reproduction = await data(await call(env, `${base}/evaluations/${evaluation.id}/inputs`));
    expect(reproduction.input_sha256).toBe(evaluation.input_sha256);
    expect((await call(env, reproduction.model.download_path)).status).toBe(200);
    expect((await call(env, `${base}/evaluations/${evaluation.id}/inputs/artifacts/artifact_other`)).status).toBe(404);
    const updated = await data(await decide(env, "models", mv, "approve", { evaluation_run_id: evaluation.id }));
    expect(updated.status).toBe("approved");
    expect((await decide(env, "models", mv, "approve", { evaluation_run_id: evaluation.id })).status).toBe(412);
    const a = await release(env, mv.id, "1"), arun = await run(env, truth.id, mv.id, a);
    await complete(env, arun);
    const aApproved = await data(await decide(env, "releases", a, "approve", { evaluation_run_id: arun.id }));
    await data(await decide(env, "releases", aApproved, "activate", {}));
    const execution = await data(await call(env, `${base}/releases/active/execution`));
    expect(execution).toMatchObject({ schema_version: "product-execution.v1", release_id: a.id, model: { id: mv.id, download_path: `${base}/models/${mv.id}/artifact` } });
    expect(JSON.parse(execution.configuration_json).components.evaluator).toBe(EVALUATION_IMPLEMENTATION_VERSION);
    const b = await release(env, mv.id, "2"), brun = await run(env, truth.id, mv.id, b);
    await complete(env, brun);
    const bApproved = await data(await decide(env, "releases", b, "approve", { evaluation_run_id: brun.id }));
    const bActive = await data(await decide(env, "releases", bApproved, "activate", {}));
    expect((await decide(env, "models", updated, "retire", {})).status).toBe(409);
    expect(env.CONTROL_DB.db.prepare("SELECT status FROM pipeline_releases WHERE id = ?").get(a.id).status).toBe("superseded");
    await data(await decide(env, "releases", bActive, "rollback", { target_release_id: a.id }));
    expect(env.CONTROL_DB.db.prepare("SELECT id FROM pipeline_releases WHERE status = 'active'").all()).toEqual([{ id: a.id }]);
    const history = await data(await call(env, `${base}/releases/${b.id}`));
    expect(history.history.map((entry) => entry.action)).toContain("release.rollback");
    expect(() => env.CONTROL_DB.db.prepare("UPDATE pipeline_releases SET configuration_json = '{}' WHERE id = ?").run(a.id)).toThrow(/immutable/);
    expect(() => env.CONTROL_DB.db.prepare("UPDATE model_versions SET license = 'changed' WHERE id = ?").run(mv.id)).toThrow(/immutable/);
    env.CONTROL_DB.db.prepare("UPDATE ground_truth_versions SET status = 'invalid', approval_status = 'rejected' WHERE id = ?").run(truth.id);
    expect((await call(env, `${base}/releases/active/execution`)).status).toBe(409);
  });
  it("rejects missing evidence, unapproved activation, stale decisions and retirement of active models", async () => {
    const prepared = await candidate(), { env, truth } = prepared; await approved(prepared);
    const mv = await model(env);
    expect((await call(env, `${base}/releases/active/execution`)).status).toBe(409);
    expect((await call(env, `${base}/releases/active/execution`, "GET", undefined, "wrong-token")).status).toBe(401);
    expect((await decide(env, "models", mv, "approve", {})).status).toBe(400);
    const evaluation = await run(env, truth.id, mv.id);
    expect((await decide(env, "models", mv, "approve", { evaluation_run_id: evaluation.id })).status).toBe(409);
    await complete(env, evaluation);
    await data(await decide(env, "models", mv, "approve", { evaluation_run_id: evaluation.id }));
    const rel = await release(env, mv.id, "one");
    expect((await decide(env, "releases", rel, "activate", {})).status).toBe(409);
    const bad = await run(env, truth.id, mv.id, rel); await complete(env, bad, 0.3);
    expect((await decide(env, "releases", rel, "approve", { evaluation_run_id: bad.id })).status).toBe(409);
    await data(await decide(env, "releases", rel, "reject", { evaluation_run_id: bad.id }));
    expect(env.CONTROL_DB.db.prepare("SELECT approval_status FROM pipeline_releases WHERE id = ?").get(rel.id).approval_status).toBe("rejected");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS count FROM pipeline_releases WHERE status = 'active'").get().count).toBe(0);
  });
  it("supports evaluation cancellation/retry, deduplication and immutable comparisons with real stored outputs", async () => {
    const prepared = await candidate(), { env, truth } = prepared; await approved(prepared);
    const mv = await model(env), evaluation = await run(env, truth.id, mv.id);
    const inputs = { ground_truth_version_id: truth.id, model_version_id: mv.id, idempotency_key: "same" };
    const first = await data(await call(env, `${base}/evaluations`, "POST", inputs), 202);
    expect((await data(await call(env, `${base}/evaluations`, "POST", inputs))).id).toBe(first.id);
    await data(await call(env, `${base}/evaluations/${first.id}/cancel`, "POST", {}));
    await data(await call(env, `${base}/evaluations/${first.id}/retry`, "POST", {}));
    await complete(env, evaluation, 0.9); await complete(env, first, 0.8);
    const comparison = await data(await call(env, `${base}/evaluations/compare?baseline_id=${evaluation.id}&candidate_id=${first.id}`));
    expect(comparison.metrics.object_f1.delta).toBe(-0.1);
    expect(comparison.source_metrics).not.toEqual({});
  });
  it("restricts model registration to researchers and decisions to release approvers", () => {
    const actor = (role) => ({ kind: "user", user: { id: "u_test", roles: [role] } });
    const req = (path) => new Request(`https://test${base}${path}`, { method: "POST" });
    expect(canAccessInternals(actor("researcher"), req("/models"))).toBe(true);
    expect(canAccessInternals(actor("researcher"), req("/models/mv_x/approve"))).toBe(false);
    expect(canAccessInternals(actor("release_approver"), req("/releases/release_x/activate"))).toBe(true);
    expect(canAccessInternals(actor("reviewer"), req("/releases"))).toBe(false);
  });
  it("recovers expired evaluation leases and fences a stale runner after cancellation", async () => {
    const prepared = await candidate(), { env, truth } = prepared; await approved(prepared);
    const mv = await model(env), evaluation = await run(env, truth.id, mv.id);
    env.RUNNER_TOKEN = "test-runner";
    const claim = () => call(env, `${base}/runner/evaluation-jobs/claim`, "POST", { runner_id: "test-runner", lease_seconds: 30 }, "test-runner");
    const first = await data(await claim());
    const past = new Date(Date.now() - 60000).toISOString();
    env.CONTROL_DB.db.prepare("UPDATE internal_jobs SET lease_expires_at = ? WHERE id = ?").run(past, evaluation.job_id);
    env.CONTROL_DB.db.prepare("UPDATE internal_job_attempts SET lease_expires_at = ? WHERE job_id = ?").run(past, evaluation.job_id);
    const second = await data(await claim());
    expect(second.job.attempt_count).toBe(2);
    expect(env.CONTROL_DB.db.prepare("SELECT status FROM internal_job_attempts WHERE id = ?").get(first.attempt_id).status).toBe("lease_expired");
    const oldHeaders = { authorization: "Bearer test-runner", "x-job-lease-token": first.lease_token };
    expect((await callWithHeaders(env, `${base}/runner/evaluation-jobs/${evaluation.job_id}/inputs`, "GET", undefined, oldHeaders)).status).toBe(409);
    await data(await call(env, `${base}/evaluations/${evaluation.id}/cancel`, "POST", {}));
    const headers = { authorization: "Bearer test-runner", "x-job-lease-token": second.lease_token };
    expect((await callWithHeaders(env, `${base}/runner/evaluation-jobs/${evaluation.job_id}/inputs`, "GET", undefined, headers)).status).toBe(409);
    const failed = await data(await callWithHeaders(env, `${base}/runner/evaluation-jobs/${evaluation.job_id}/fail`, "POST", { error_message: "cancelled", requeue: true }, headers));
    expect(failed.status).toBe("cancelled");
    expect((await data(await call(env, `${base}/evaluations/${evaluation.id}`))).status).toBe("cancelled");
  });
});
