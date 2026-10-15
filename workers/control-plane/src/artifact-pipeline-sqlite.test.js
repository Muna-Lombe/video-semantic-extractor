/** @type test @purpose Verify repeated sampling finalization against real SQLite constraints and existing legacy frames. */
import { it, expect } from "vitest";
import { environment, frameSet } from "./registry-test-support";
import { handleArtifactPipeline, sha256Hex } from "./artifact-pipeline";

it("preserves existing frame sets when finalizing a job with namespaced frame IDs", async () => {
  const env = environment();
  await frameSet(env);
  env.CONTROL_DB.db.exec("UPDATE frame_set_frames SET id = 'frame_0_0'");
  env.DATASET_DB = {
    prepare: () => ({
      bind() { return this; },
      async all() { return { results: [{ id: "src_test" }] }; },
    }),
  };
  const hash = await sha256Hex("lease"), now = new Date().toISOString();
  const expiry = new Date(Date.now() + 600_000).toISOString();
  env.CONTROL_DB.db.prepare(`INSERT INTO internal_jobs
    (id, job_type, status, input_json, created_at, updated_at, lease_token_hash, lease_expires_at, attempt_count)
    VALUES ('job_new', 'sampling', 'running', ?, ?, ?, ?, ?, 1)`)
    .run(JSON.stringify({ dataset_version_id: "dsv_test" }), now, now, hash, expiry);
  env.CONTROL_DB.db.prepare(`INSERT INTO internal_job_attempts
    (id, job_id, attempt_number, status, worker_id, lease_token_hash, leased_at, lease_expires_at)
    VALUES ('attempt_new', 'job_new', 1, 'running', 'test', ?, ?, ?)`)
    .run(hash, now, expiry);

  const frames = [], base = "/api/internal/v1/runner/sampling-jobs/job_new";
  const bytes = new Uint8Array([1, 2, 3]), checksum = await sha256Hex(bytes.buffer);
  const request = (path, payload) => new Request(`https://internal.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-job-lease-token": "lease" },
    body: JSON.stringify(payload),
  });
  for (let index = 0; index < 8; index += 1) {
    const reserved = await handleArtifactPipeline(request(`${base}/artifacts`, {
      sha256: checksum, size_bytes: 3, media_type: "image/jpeg",
    }), env, "job_new", "artifacts");
    expect(reserved.status).toBe(201);
    const artifact = (await reserved.json()).data;
    const uploaded = await handleArtifactPipeline(new Request(`https://internal.test${artifact.upload_path}`, {
      method: "PUT",
      headers: { "content-type": "image/jpeg", "content-length": "3", "x-job-lease-token": "lease" },
      body: bytes,
    }), env, "job_new", "artifacts", artifact.id);
    expect(uploaded.status).toBe(200);
    frames.push({
      id: `frame_0_${index}`, timestamp_seconds: index, reasons: [index === 0 ? "first" : "interval"],
      width: 640, height: 360,
      artifact: { artifact_id: artifact.id, sha256: checksum, size_bytes: 3, media_type: "image/jpeg" },
    });
  }
  const manifest = {
    schema_version: "frame-set-manifest.v1", frame_set_id: "frameset_new", sampling_job_id: "job_new",
    dataset_version_id: "dsv_test", created_at: now,
    engine: { name: "sampler", version: "test", configuration_sha256: "a".repeat(64) },
    source_count: 1, frame_count: frames.length,
    sources: [{ dataset_source_id: "src_test", source_sha256: "b".repeat(64), size_bytes: 100, duration_seconds: 60, frames }],
  };

  // Reusing the legacy IDs reproduces the hosted failure and rolls back registration.
  await expect(handleArtifactPipeline(request(`${base}/finalize`, { manifest }), env, "job_new", "finalize"))
    .rejects.toThrow(/UNIQUE constraint failed: frame_set_frames.id/);
  expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM frame_sets").get().n).toBe(1);
  expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'frame_manifest'").get().n).toBe(1);

  frames.forEach((frame, index) => { frame.id = `frame_job_new_0_${index}`; });
  const response = await handleArtifactPipeline(request(`${base}/finalize`, { manifest }), env, "job_new", "finalize");
  expect(response.status).toBe(201);
  expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM frame_sets").get().n).toBe(2);
  expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM frame_set_frames").get().n).toBe(9);
  expect(env.CONTROL_DB.db.prepare("SELECT id FROM frame_set_frames WHERE frame_set_id = 'fs_test'").get().id).toBe("frame_0_0");
});
