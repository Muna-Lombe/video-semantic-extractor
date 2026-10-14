/** @type test @purpose Verify validated pipeline lineage links and derived progress. */
import { describe, expect, it } from "vitest";
import { environment } from "./registry-test-support";
import { handleInternalsApi } from "./internals";
import { handlePipelineTracking } from "./pipeline-tracking";

function datasetDatabase() {
  const datasets = new Map([["dataset-1", { status: "ready", label: "Training corpus" }]]);
  const versions = new Map([["version-1", { status: "frozen", label: "version-1" }]]);
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) { values = bound; return this; },
        async first() {
          if (sql.includes("FROM datasets")) return datasets.get(values[0]) ?? null;
          if (sql.includes("FROM dataset_versions")) return versions.get(values[0]) ?? null;
          throw new Error(`Unexpected dataset query: ${sql}`);
        },
      };
    },
  };
}

function request(path, method = "GET", payload, headers = {}) {
  return new Request(`https://internal.test/api/internal/v1${path}`, {
    method,
    headers: { authorization: "Bearer test-admin", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function call(env, path, method = "GET", payload) {
  const response = await handlePipelineTracking(request(path, method, payload), env);
  expect(response).not.toBeNull();
  return response;
}

function seedResources(env) {
  const db = env.CONTROL_DB.db;
  db.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, created_at, updated_at) VALUES (?, ?, ?, '{}', 'now', 'now')")
    .run("sampling-1", "sampling", "succeeded");
  db.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, created_at, updated_at) VALUES (?, ?, ?, '{}', 'now', 'now')")
    .run("evaluation-job-1", "evaluation", "succeeded");
  db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, created_at) VALUES (?, ?, ?, ?, 'now')")
    .run("manifest-1", "frame_manifest", "manifest-1.json", "a".repeat(64));
  db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, created_at) VALUES (?, ?, ?, ?, 'now')")
    .run("template-artifact-1", "template", "template-1.json", "b".repeat(64));
  db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, created_at) VALUES (?, ?, ?, ?, 'now')")
    .run("ground-truth-artifact-1", "ground_truth", "ground-truth-1.json", "c".repeat(64));
  db.prepare("INSERT INTO frame_sets (id, dataset_version_id, sampling_job_id, manifest_artifact_id, source_count, frame_count, sha256, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, 'now')")
    .run("frame-set-1", "version-1", "sampling-1", "manifest-1", "a".repeat(64));
  db.prepare("INSERT INTO policies (id, name, task_type, created_at) VALUES ('policy-1', 'Policy', 'objects', 'now')").run();
  db.prepare("INSERT INTO policy_versions (id, policy_id, version, definition_json, created_at) VALUES ('policy-version-1', 'policy-1', '1', '{}', 'now')").run();
  db.prepare("INSERT INTO templates (id, frame_set_id, policy_version_id, artifact_id, schema_version, frame_count, sha256, created_at) VALUES ('template-1', 'frame-set-1', 'policy-version-1', 'template-artifact-1', 'v1', 1, ?, 'now')")
    .run("b".repeat(64));
  db.prepare("INSERT INTO review_campaigns (id, name, template_id, status, created_at, updated_at) VALUES ('campaign-1', 'Review', 'template-1', 'completed', 'now', 'now')").run();
  db.prepare("INSERT INTO ground_truth_versions (id, campaign_id, artifact_id, created_at) VALUES ('ground-truth-1', 'campaign-1', 'ground-truth-artifact-1', 'now')").run();
  db.prepare("INSERT INTO models (id, name, task_type, created_at) VALUES ('model-1', 'Model', 'objects', 'now')").run();
  db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, created_at) VALUES ('model-artifact-1', 'model', 'model-1.bin', ?, 'now')").run("d".repeat(64));
  db.prepare("INSERT INTO model_versions (id, model_id, version, artifact_id, configuration_json, status, created_at) VALUES ('model-version-1', 'model-1', '1', 'model-artifact-1', '{}', 'approved', 'now')").run();
  db.prepare("INSERT INTO pipeline_releases (id, version, configuration_json, status, created_at) VALUES ('release-1', '1', '{}', 'active', 'now')").run();
  db.prepare("INSERT INTO evaluation_runs (id, job_id, ground_truth_version_id, model_version_id, pipeline_release_id, configuration_json, created_at) VALUES ('evaluation-1', 'evaluation-job-1', 'ground-truth-1', 'model-version-1', 'release-1', '{}', 'now')").run();
}

describe("pipeline tracking", () => {
  it("links supported resources, computes progress from their live statuses, and rejects invalid links", async () => {
    const env = environment();
    env.ADMIN_TOKEN = "test-admin";
    env.DATASET_DB = datasetDatabase();
    seedResources(env);

    const created = await call(env, "/pipelines", "POST", { name: "Object review pipeline", description: "Track the diagnostic workflow." });
    expect(created.status).toBe(201);
    const pipeline = (await created.json()).data;
    expect(pipeline.progress).toEqual({ status: "not_started", completed_count: 0, total_count: 0, percentage: 0 });
    expect(pipeline.status).toBe("active");

    const resources = [
      ["dataset", "dataset-1"], ["dataset_version", "version-1"], ["sampling_job", "sampling-1"],
      ["frame_set", "frame-set-1"], ["template", "template-1"], ["review_campaign", "campaign-1"],
      ["evaluation_run", "evaluation-1"], ["model_version", "model-version-1"], ["pipeline_release", "release-1"],
    ].map(([resource_type, resource_id]) => ({ resource_type, resource_id }));
    const linked = await call(env, `/pipelines/${pipeline.id}/resources`, "POST", resources[0]);
    expect(linked.status).toBe(201);
    for (const resource of resources.slice(1)) {
      const response = await call(env, `/pipelines/${pipeline.id}/resources`, "POST", resource);
      expect(response.status).toBe(201);
    }
    const complete = await call(env, `/pipelines/${pipeline.id}`);
    const detail = (await complete.json()).data;
    expect(detail.progress).toEqual({ status: "complete", completed_count: 9, total_count: 9, percentage: 100 });
    expect(detail.resources.find((resource) => resource.resource_type === "evaluation_run").lineage).toEqual(expect.objectContaining({
      ground_truth_version_id: "ground-truth-1",
      review_campaign_id: "campaign-1",
      template_id: "template-1",
      frame_set_id: "frame-set-1",
      dataset_version_id: "version-1",
      sampling_job_id: "sampling-1",
    }));

    const duplicate = await call(env, `/pipelines/${pipeline.id}/resources`, "POST", resources[0]);
    expect(duplicate.status).toBe(409);
    const missing = await call(env, `/pipelines/${pipeline.id}/resources`, "POST", { resource_type: "template", resource_id: "missing-template" });
    expect(missing.status).toBe(404);

    env.CONTROL_DB.db.prepare("UPDATE internal_jobs SET status = 'running' WHERE id = 'sampling-1'").run();
    const inProgress = await call(env, `/pipelines/${pipeline.id}`);
    expect((await inProgress.json()).data.progress).toEqual({ status: "in_progress", completed_count: 8, total_count: 9, percentage: 89 });

    const unlinked = await call(env, `/pipelines/${pipeline.id}/resources/template/template-1`, "DELETE");
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).data.progress).toEqual({ status: "in_progress", completed_count: 7, total_count: 8, percentage: 88 });
  });

  it("validates pipeline input and enforces role authorization", async () => {
    const env = environment();
    env.ADMIN_TOKEN = "test-admin";
    env.DATASET_DB = datasetDatabase();
    const invalid = await call(env, "/pipelines", "POST", { name: " " });
    expect(invalid.status).toBe(400);

    const forbidden = await handlePipelineTracking(new Request("https://internal.test/api/internal/v1/pipelines", {
      headers: { authorization: "Bearer assignment-token" },
    }), env);
    expect(forbidden.status).toBe(401);
  });

  it("is reachable through the authenticated Internals API router", async () => {
    const env = environment();
    env.ADMIN_TOKEN = "test-admin";
    const response = await handleInternalsApi(request("/pipelines"), env);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([]);
  });
});
