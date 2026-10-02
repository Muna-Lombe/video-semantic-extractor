/** @type test @purpose Verify the D1-backed Internals dataset and sampling metadata APIs. */
import { describe, expect, it } from "vitest";
import { handleInternalsApi } from "./internals";
import type { AdjudicationEnv } from "./types";

type Row = Record<string, unknown>;

class MemoryStatement {
  constructor(private database: MemoryD1, private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new MemoryStatement(this.database, this.sql, values); }
  async run() {
    if (this.sql.startsWith("INSERT INTO datasets ")) {
      const [id, name, description, created_at, updated_at] = this.values;
      this.database.datasets.push({ id, name, description, status: "ready", created_at, updated_at });
    } else if (this.sql.startsWith("INSERT INTO dataset_versions ")) {
      const [id, dataset_id, created_at] = this.values;
      this.database.versions.push({ id, dataset_id, version: 1, status: "frozen", manifest_artifact_id: null, created_at });
    } else if (this.sql.startsWith("INSERT INTO dataset_sources ")) {
      const [id, dataset_version_id, source_url, display_name, ordinal, created_at] = this.values;
      this.database.sources.push({ id, dataset_version_id, source_url, url: source_url, display_name, ordinal, created_at });
    } else if (this.sql.startsWith("INSERT INTO internal_jobs ")) {
      const [id, input_json, created_at, updated_at] = this.values;
      this.database.jobs.push({ id, job_type: "sampling", status: "queued", input_json, progress_json: null, output_json: null, error_message: null, created_at, started_at: null, completed_at: null, updated_at });
    } else throw new Error(`unsupported run: ${this.sql}`);
    return { success: true };
  }
  async first<T>() {
    if (this.sql.startsWith("SELECT id, status FROM dataset_versions")) return (this.database.versions.find((row) => row.id === this.values[0]) ?? null) as T | null;
    if (this.sql.includes("FROM datasets WHERE id")) {
      const row = this.database.datasets.find((item) => item.id === this.values[0]);
      if (!row) return null;
      const versionIds = new Set(this.database.versions.filter((item) => item.dataset_id === row.id).map((item) => item.id));
      return { ...row, source_count: this.database.sources.filter((item) => versionIds.has(item.dataset_version_id)).length } as T;
    }
    if (this.sql.includes("FROM internal_jobs WHERE id")) return (this.database.jobs.find((row) => row.id === this.values[0]) ?? null) as T | null;
    throw new Error(`unsupported first: ${this.sql}`);
  }
  async all<T>() {
    if (this.sql.includes("FROM datasets d")) {
      const limit = Number(this.values.at(-2)), offset = Number(this.values.at(-1));
      const requestedStatus = this.values.length === 3 ? this.values[0] : null;
      const rows = this.database.datasets.filter((row) => requestedStatus === null || row.status === requestedStatus).map((row) => {
        const version = this.database.versions.find((item) => item.dataset_id === row.id);
        const source_count = this.database.sources.filter((item) => item.dataset_version_id === version?.id).length;
        return { ...row, latest_version_id: version?.id, latest_version_number: version?.version, latest_version_status: version?.status, source_count };
      }).slice(offset, offset + limit);
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM dataset_versions WHERE dataset_id")) return { results: this.database.versions.filter((row) => row.dataset_id === this.values[0]) as T[] };
    if (this.sql.includes("FROM dataset_sources ds")) {
      const versionIds = new Set(this.database.versions.filter((item) => item.dataset_id === this.values[0]).map((item) => item.id));
      return { results: this.database.sources.filter((row) => versionIds.has(row.dataset_version_id)) as T[] };
    }
    if (this.sql.includes("FROM internal_jobs WHERE job_type")) {
      const limit = Number(this.values[0]), offset = Number(this.values[1]);
      return { results: this.database.jobs.slice(offset, offset + limit) as T[] };
    }
    throw new Error(`unsupported all: ${this.sql}`);
  }
}

class MemoryD1 {
  datasets: Row[] = [];
  versions: Row[] = [];
  sources: Row[] = [];
  jobs: Row[] = [];
  prepare(sql: string) { return new MemoryStatement(this, sql); }
  async batch(statements: MemoryStatement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

function environment(controlDatabase = new MemoryD1(), datasetDatabase = new MemoryD1()): AdjudicationEnv {
  return { CONTROL_DB: controlDatabase as unknown as D1Database, DATASET_DB: datasetDatabase as unknown as D1Database, REVIEW_BUCKET: {} as R2Bucket, ADMIN_TOKEN: "admin-secret", ASSETS: {} as Fetcher };
}

function request(path: string, method = "GET", payload?: unknown, token = "admin-secret") {
  return new Request(`https://internal.test${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

async function response(requestValue: Request, env: AdjudicationEnv) {
  const result = await handleInternalsApi(requestValue, env);
  expect(result).not.toBeNull();
  return result!;
}

describe("Internals control-plane API", () => {
  it("registers a dataset and exposes its initial version", async () => {
    const env = environment();
    const created = await response(request("/api/internal/v1/datasets", "POST", { name: "OCR baseline", description: "Caption-heavy clips", sources: [{ url: "https://media.example/clip.mp4" }] }), env);
    expect(created.status).toBe(201);
    const dataset = (await created.json() as any).data;
    expect(dataset).toEqual(expect.objectContaining({ name: "OCR baseline", status: "ready", source_count: 1, initial_version: expect.objectContaining({ version: 1, status: "frozen" }) }));

    const listed = await response(request("/api/internal/v1/datasets"), env);
    const listing = await listed.json() as any;
    expect(listing.data).toHaveLength(1);
    expect(listing.data[0].latest_version.id).toBe(dataset.initial_version.id);

    const detail = await response(request(`/api/internal/v1/datasets/${dataset.id}`), env);
    const detailData = (await detail.json() as any).data;
    expect(detailData.versions).toContainEqual(expect.objectContaining({ id: dataset.initial_version.id, status: "frozen" }));
    expect(detailData.sources).toContainEqual(expect.objectContaining({ dataset_version_id: dataset.initial_version.id, url: "https://media.example/clip.mp4" }));
  });

  it("records validated sampling intent without claiming execution", async () => {
    const env = environment();
    const datasetResponse = await response(request("/api/internal/v1/datasets", "POST", { name: "Sampling corpus", sources: [{ url: "https://media.example/sample.mp4" }] }), env);
    const versionId = (await datasetResponse.json() as any).data.initial_version.id;
    const created = await response(request("/api/internal/v1/sampling-jobs", "POST", { dataset_version_id: versionId, method: "hybrid", scene_threshold: 0.3, interval_seconds: 5, max_frames: 80 }), env);
    expect(created.status).toBe(202);
    const payload = await created.json() as any;
    expect(payload.data).toEqual(expect.objectContaining({ type: "sampling", status: "queued" }));
    expect(payload.meta).toEqual({ execution_scheduled: false, runner: "legacy_cli" });

    const listed = await response(request("/api/internal/v1/sampling-jobs"), env);
    expect((await listed.json() as any).data).toContainEqual(expect.objectContaining({ id: payload.data.id, input: expect.objectContaining({ dataset_version_id: versionId, method: "hybrid" }) }));
  });

  it("rejects invalid input and non-administrator credentials", async () => {
    const env = environment();
    expect((await response(request("/api/internal/v1/datasets", "POST", { name: "x", sources: [{ url: "http://insecure.example/video.mp4" }] }), env)).status).toBe(400);
    expect((await response(request("/api/internal/v1/sampling-jobs", "POST", { dataset_version_id: "missing", method: "hybrid" }), env)).status).toBe(400);
    expect((await response(request("/api/internal/v1/datasets", "GET", undefined, "wrong"), env)).status).toBe(401);
  });
});
