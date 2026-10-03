/** @type test @purpose Verify lease-bound artifact verification and frame-set finalization. */
import { describe, expect, it } from "vitest";
import { handleArtifactPipeline, sha256Hex } from "./artifact-pipeline";
import type { AdjudicationEnv } from "./types";

type Row = Record<string, any>;

class MemoryBucket {
  objects = new Map<string, { bytes: ArrayBuffer; size: number; customMetadata?: Record<string, string>; httpMetadata?: R2HTTPMetadata }>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: R2PutOptions) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value).buffer : value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
    const stored = { bytes, size: bytes.byteLength, customMetadata: options?.customMetadata, httpMetadata: options?.httpMetadata as R2HTTPMetadata };
    this.objects.set(key, stored);
    return stored as unknown as R2Object;
  }
  async head(key: string) { return (this.objects.get(key) ?? null) as unknown as R2Object | null; }
  async delete(key: string) { this.objects.delete(key); }
}

class Statement {
  constructor(public db: MemoryControl, public sql: string, public values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>(): Promise<T | null> {
    if (this.sql.startsWith("INSERT INTO artifact_uploads")) {
      const [artifactId, leaseHash, storageKey, sha256, sizeBytes, mediaType, createdAt, jobId, expectedHash] = this.values;
      if (!this.db.active(jobId, expectedHash)) return null;
      const row = { id: artifactId, sampling_job_id: jobId, lease_token_hash: leaseHash, kind: "frame_image", storage_key: storageKey, sha256, size_bytes: sizeBytes, media_type: mediaType, status: "reserved", created_at: createdAt };
      this.db.uploads.push(row);
      return row as T;
    }
    if (this.sql.startsWith("SELECT au.* FROM artifact_uploads")) {
      const [artifactId, jobId, leaseHash] = this.values;
      return (this.db.uploads.find((row) => row.id === artifactId && row.sampling_job_id === jobId && row.lease_token_hash === leaseHash && this.db.active(jobId, leaseHash)) ?? null) as T | null;
    }
    if (this.sql.startsWith("UPDATE artifact_uploads SET status = 'uploaded'")) {
      const [uploadedAt, artifactId, jobId, leaseHash] = this.values;
      const row = this.db.uploads.find((candidate) => candidate.id === artifactId && candidate.sampling_job_id === jobId && candidate.lease_token_hash === leaseHash && this.db.active(jobId, leaseHash));
      if (!row) return null;
      Object.assign(row, { status: "uploaded", uploaded_at: uploadedAt });
      return row as T;
    }
    if (this.sql.startsWith("SELECT id, manifest_artifact_id")) return (this.db.frameSets.find((row) => row.sampling_job_id === this.values[0] && row.finalized_by_lease_hash === this.values[1]) ?? null) as T | null;
    if (this.sql.startsWith("SELECT id, input_json, attempt_count")) return (this.db.active(this.values[0], this.values[1]) ? this.db.job : null) as T | null;
    if (this.sql.startsWith("SELECT id, storage_key, sha256")) return (this.db.uploads.find((row) => row.id === this.values[0] && row.sampling_job_id === this.values[1] && row.lease_token_hash === this.values[2] && row.status === "uploaded") ?? null) as T | null;
    throw new Error(`unsupported first: ${this.sql}`);
  }
}

class MemoryControl {
  job: Row;
  uploads: Row[] = [];
  frameSets: Row[] = [];
  constructor(leaseHash: string) {
    this.job = { id: "job_123", job_type: "sampling", status: "running", input_json: JSON.stringify({ dataset_version_id: "dsv_123" }), attempt_count: 1, lease_token_hash: leaseHash, lease_expires_at: "2999-01-01T00:00:00.000Z", cancellation_requested_at: null };
  }
  active(jobId: unknown, leaseHash: unknown) { return this.job.id === jobId && this.job.status === "running" && this.job.lease_token_hash === leaseHash; }
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    const frameSetStatement = statements.find((statement) => statement.sql.startsWith("INSERT INTO frame_sets"))!;
    const [frameSetId, datasetVersionId, manifestArtifactId, sourceCount, frameCount, sha256, createdAt, schemaVersion, engineName, engineVersion, configurationSha, leaseHash, jobId] = frameSetStatement.values;
    this.frameSets.push({ id: frameSetId, dataset_version_id: datasetVersionId, sampling_job_id: jobId, manifest_artifact_id: manifestArtifactId, source_count: sourceCount, frame_count: frameCount, sha256, created_at: createdAt, manifest_schema_version: schemaVersion, engine_name: engineName, engine_version: engineVersion, engine_configuration_sha256: configurationSha, finalized_by_lease_hash: leaseHash, status: "ready" });
    this.uploads.forEach((upload) => { if (upload.sampling_job_id === jobId) upload.status = "finalized"; });
    this.job.status = "succeeded";
    this.job.lease_token_hash = null;
    return statements.map(() => ({ success: true }));
  }
}

class DatasetStatement {
  constructor(private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new DatasetStatement(this.sql, values); }
  async all<T>() { return { results: this.values[0] === "dsv_123" ? [{ id: "src_123" }] as T[] : [] }; }
}

function jsonRequest(path: string, method: string, payload: unknown, lease = "lease") {
  return new Request(`https://internal.test${path}`, { method, headers: { "content-type": "application/json", "x-job-lease-token": lease }, body: JSON.stringify(payload) });
}

async function setup() {
  const leaseHash = await sha256Hex("lease");
  const control = new MemoryControl(leaseHash);
  const bucket = new MemoryBucket();
  const env = { CONTROL_DB: control as unknown as D1Database, DATASET_DB: { prepare: (sql: string) => new DatasetStatement(sql) } as unknown as D1Database, INTERNAL_ARTIFACTS_BUCKET: bucket as unknown as R2Bucket, REVIEW_BUCKET: {} as R2Bucket, ADMIN_TOKEN: "admin", RUNNER_TOKEN: "runner", ASSETS: {} as Fetcher } satisfies AdjudicationEnv;
  return { control, bucket, env };
}

describe("sampling artifact pipeline", () => {
  it("verifies uploaded bytes and finalizes an immutable frame set idempotently", async () => {
    const { control, bucket, env } = await setup();
    const bytes = new TextEncoder().encode("image bytes");
    const checksum = await sha256Hex(bytes.buffer);
    const base = "/api/internal/v1/runner/sampling-jobs/job_123";
    const reserved = await handleArtifactPipeline(jsonRequest(`${base}/artifacts`, "POST", { sha256: checksum, size_bytes: bytes.byteLength, media_type: "image/jpeg" }), env, "job_123", "artifacts");
    expect(reserved?.status).toBe(201);
    const reservation = (await reserved!.json() as any).data;
    const upload = new Request(`https://internal.test${reservation.upload_path}`, { method: "PUT", headers: { "content-type": "image/jpeg", "content-length": String(bytes.byteLength), "x-job-lease-token": "lease" }, body: bytes });
    expect((await handleArtifactPipeline(upload, env, "job_123", "artifacts", reservation.id))?.status).toBe(200);

    const sha = "a".repeat(64);
    const manifest = { schema_version: "frame-set-manifest.v1", frame_set_id: "frameset_123", sampling_job_id: "job_123", dataset_version_id: "dsv_123", created_at: "2026-10-03T12:00:00.000Z", engine: { name: "sampler", version: "1", configuration_sha256: sha }, source_count: 1, frame_count: 1, sources: [{ dataset_source_id: "src_123", source_sha256: sha, size_bytes: 100, duration_seconds: 10, frames: [{ id: "frame_123", timestamp_seconds: 5, reasons: ["interval"], width: 640, height: 360, artifact: { artifact_id: reservation.id, sha256: checksum, size_bytes: bytes.byteLength, media_type: "image/jpeg" } }] }] };
    const finalized = await handleArtifactPipeline(jsonRequest(`${base}/finalize`, "POST", { manifest }), env, "job_123", "finalize");
    expect(finalized?.status).toBe(201);
    expect(control.job.status).toBe("succeeded");
    expect(control.uploads[0].status).toBe("finalized");
    expect([...bucket.objects.keys()]).toEqual(expect.arrayContaining([expect.stringContaining("/frames/"), expect.stringMatching(/^sampling\/job_123\/manifests\/[a-f0-9]{64}\.json$/)]));

    const retried = await handleArtifactPipeline(jsonRequest(`${base}/finalize`, "POST", { manifest }), env, "job_123", "finalize");
    expect(retried?.status).toBe(200);
    expect((await retried!.json() as any).meta.deduplicated).toBe(true);
  });

  it("rejects bytes that do not match the reserved checksum", async () => {
    const { env } = await setup();
    const base = "/api/internal/v1/runner/sampling-jobs/job_123";
    const reserved = await handleArtifactPipeline(jsonRequest(`${base}/artifacts`, "POST", { sha256: "a".repeat(64), size_bytes: 3, media_type: "image/png" }), env, "job_123", "artifacts");
    const reservation = (await reserved!.json() as any).data;
    const upload = new Request(`https://internal.test${reservation.upload_path}`, { method: "PUT", headers: { "content-type": "image/png", "content-length": "3", "x-job-lease-token": "lease" }, body: "bad" });
    const response = await handleArtifactPipeline(upload, env, "job_123", "artifacts", reservation.id);
    expect(response?.status).toBe(422);
    expect((await response!.json() as any).error.code).toBe("checksum_mismatch");
  });
});
