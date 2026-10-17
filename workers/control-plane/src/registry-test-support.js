/** @type test @purpose Exercise registry routes with actual SQLite constraints, transactions, and private artifact storage. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect } from "vitest";
import { handleInternalsApi } from "./internals";
import { sha256Hex } from "./artifact-pipeline";
import { ANNOTATION_SCHEMA_VERSION } from "./template-registry";

const databases = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });

class SQLiteD1 {
  constructor(kind = "control") {
    this.db = new DatabaseSync(":memory:");
    databases.push(this.db);
    const migrations = new URL(`../migrations/${kind}/`, import.meta.url);
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) this.db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  prepare(sql) {
    const database = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() { return database.db.prepare(sql).get(...this.values) ?? null; },
      async all() { return { success: true, results: database.db.prepare(sql).all(...this.values) }; },
      execute() { return /\bRETURNING\b/i.test(sql) ? { success: true, results: database.db.prepare(sql).all(...this.values) } : { success: true, meta: database.db.prepare(sql).run(...this.values) }; },
      async run() { return this.execute(); },
    };
  }
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }
}

class MemoryBucket {
  objects = new Map();
  async put(key, content, options = {}) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    this.objects.set(key, { key, etag: crypto.randomUUID(), uploaded: new Date(), bytes, size: bytes.byteLength, ...options });
  }
  async list({ limit = 100, cursor } = {}) {
    const all = [...this.objects.values()].sort((a, b) => a.key.localeCompare(b.key));
    const offset = cursor ? Number(cursor) : 0;
    return { objects: all.slice(offset, offset + limit), truncated: all.length > offset + limit, cursor: String(offset + limit) };
  }
  async delete(key) { this.objects.delete(key); }
  async head(key) { return this.objects.get(key) ?? null; }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { ...object, text: async () => new TextDecoder().decode(object.bytes), arrayBuffer: async () => object.bytes.slice().buffer } : null;
  }
}

function environment() {
  return { CONTROL_DB: new SQLiteD1(), DATASET_DB: new SQLiteD1("dataset"), INTERNAL_ARTIFACTS_BUCKET: new MemoryBucket(), ADMIN_TOKEN: "test-admin", REVIEW_BUCKET: { get: async () => null } };
}
function request(path, method = "GET", payload, token = "test-admin") {
  return new Request(`https://internal.test/api/internal/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
}
async function call(env, path, method = "GET", payload, token) {
  const result = await handleInternalsApi(request(path, method, payload, token), env);
  expect(result).not.toBeNull();
  return result;
}
const policyInput = { name: "Diagnostic object annotation", version: "2026-09-18", annotation_schema_version: ANNOTATION_SCHEMA_VERSION, document: "Use COCO classes, source pixel boxes, and live/composited/screen subsets. Two independent human passes precede adjudication." };
async function policy(env, input = policyInput) {
  const response = await call(env, "/policies", "POST", input);
  expect(response.status).toBe(201);
  return (await response.json()).data;
}
async function frameSet(env, sourceCount = 1) {
  const frameBytes = new Uint8Array([1, 2, 3]);
  const frameSha = await sha256Hex(frameBytes.buffer);
  const manifest = {
    schema_version: "frame-set-manifest.v1", frame_set_id: "fs_test", sampling_job_id: "job_test", dataset_version_id: "dsv_test", created_at: "2026-10-13T12:00:00.000Z",
    engine: { name: "shared-sampler", version: "1", configuration_sha256: "a".repeat(64) }, source_count: sourceCount, frame_count: sourceCount,
    sources: Array.from({ length: sourceCount }, (_, index) => ({ dataset_source_id: sourceCount === 1 ? "src_test" : `src_test_${index}`, source_sha256: sourceCount === 1 ? "b".repeat(64) : String(index + 1).repeat(64), size_bytes: 100, duration_seconds: 5, frames: [{ id: sourceCount === 1 ? "frame_test" : `frame_test_${index}`, timestamp_seconds: 0, reasons: ["first"], width: sourceCount === 1 ? 320 : 1000, height: sourceCount === 1 ? 180 : 1000, artifact: { artifact_id: sourceCount === 1 ? "artifact_frame" : `artifact_frame_${index}`, sha256: frameSha, size_bytes: 3, media_type: "image/jpeg" } }] })),
  };
  const manifestText = JSON.stringify(manifest), manifestSha = await sha256Hex(manifestText);
  const db = env.CONTROL_DB.db;
  db.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, created_at, updated_at) VALUES ('job_test', 'sampling', 'succeeded', '{}', 'now', 'now')").run();
  db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES ('artifact_manifest', 'frame_manifest', 'manifest.json', ?, ?, 'application/json', 'now')").run(manifestSha, new TextEncoder().encode(manifestText).byteLength);
  db.prepare("INSERT INTO frame_sets (id, dataset_version_id, sampling_job_id, manifest_artifact_id, source_count, frame_count, sha256, created_at) VALUES ('fs_test', 'dsv_test', 'job_test', 'artifact_manifest', ?, ?, ?, 'now')").run(sourceCount, sourceCount, manifestSha);
  await env.INTERNAL_ARTIFACTS_BUCKET.put("manifest.json", manifestText);
  for (const [ordinal, source] of manifest.sources.entries()) {
    const frame = source.frames[0], key = sourceCount === 1 ? "frame.jpg" : `frame_${ordinal}.jpg`;
    db.prepare("INSERT INTO artifacts (id, kind, storage_key, sha256, size_bytes, media_type, created_at) VALUES (?, 'frame_image', ?, ?, 3, 'image/jpeg', 'now')").run(frame.artifact.artifact_id, key, frameSha);
    db.prepare("INSERT INTO frame_set_sources VALUES ('fs_test', ?, ?, ?, 100, 5)").run(source.dataset_source_id, ordinal, source.source_sha256);
    db.prepare("INSERT INTO frame_set_frames VALUES (?, 'fs_test', ?, 0, 0, '[\"first\"]', ?, ?, ?)").run(frame.id, source.dataset_source_id, frame.artifact.artifact_id, frame.width, frame.height);
    await env.INTERNAL_ARTIFACTS_BUCKET.put(key, frameBytes.buffer, { customMetadata: { sha256: frameSha }, httpMetadata: { contentType: "image/jpeg" } });
  }
  return manifest;
}
function templateInput(policyId) { return { frame_set_id: "fs_test", policy_version_id: policyId, annotation_schema_version: ANNOTATION_SCHEMA_VERSION }; }


export { environment, request, call, policy, frameSet, templateInput, policyInput };
