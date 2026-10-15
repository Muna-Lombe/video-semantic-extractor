/** @type test @purpose Verify managed evaluation request validation and durable input registration boundaries. */
import { describe, expect, it } from "vitest";
import { environment, request, call } from "./registry-test-support";
import { compareEvaluationOutputs } from "./evaluations";

describe("managed evaluation API", () => {
  it("compares immutable run metrics and source slices without changing either result", () => {
    const baseline = { id: "evaluation_a", job_status: "succeeded", ground_truth_version_id: "gt_same", model_version_id: "model_a", input_sha256: "a".repeat(64), output_json: JSON.stringify({ object_f1: 0.5, p95_inference_ms: 10, sources: { src_a: { true_positives: 1, false_positives: 1, false_negatives: 1, object_precision: 0.5, object_recall: 0.5 } } }) };
    const candidate = { id: "evaluation_b", job_status: "succeeded", ground_truth_version_id: "gt_same", model_version_id: "model_b", input_sha256: "b".repeat(64), output_json: JSON.stringify({ object_f1: 0.75, p95_inference_ms: 8, sources: { src_a: { true_positives: 3, false_positives: 1, false_negatives: 1, object_precision: 0.75, object_recall: 0.75 } } }) };

    const comparison = compareEvaluationOutputs(baseline, candidate);

    expect(comparison.same_ground_truth).toBe(true);
    expect(comparison.metrics.object_f1).toEqual({ baseline: 0.5, candidate: 0.75, delta: 0.25 });
    expect(comparison.metrics.p95_inference_ms.delta).toBe(-2);
    expect(comparison.source_metrics.src_a.candidate.object_precision).toBe(0.75);
    expect(baseline.output_json).toContain('"object_f1":0.5');
  });

  it("rejects malformed resource identifiers before querying registered inputs", async () => {
    const env = environment();
    const result = await call(env, "/evaluations", "POST", {
      ground_truth_version_id: "gt/../../private",
      model_version_id: "model_1",
    });
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe("evaluation_request_failed");
  });

  it("returns not found for a well-formed but missing ground-truth version", async () => {
    const env = environment();
    const result = await call(env, "/evaluations", "POST", {
      ground_truth_version_id: "gt_missing",
      model_version_id: "model_version_missing",
    });
    expect(result.status).toBe(404);
    expect((await result.json()).error.message).toMatch(/not found/i);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS count FROM internal_jobs").get().count).toBe(0);
  });
});
