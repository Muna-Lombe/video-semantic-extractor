/** @type test @purpose Verify race-safe sampling-job claims, leases, expiry, cancellation, and retry. */
import { describe, expect, it } from "vitest";
import { handleAdminJobAction, handleRunnerApi } from "./job-lifecycle";
import type { AdjudicationEnv } from "./types";

type Row = Record<string, any>;

class Statement {
  constructor(private db: MemoryJobs, private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() {
    if (this.sql.startsWith("UPDATE internal_jobs SET status = 'running'")) {
      const job = this.db.jobs.find((item) => ((item.status === "queued") || (item.status === "running" && item.lease_expires_at <= String(this.values[7]))) && !item.cancellation_requested_at && item.attempt_count < item.max_attempts);
      if (!job) return null;
      const [owner, hash, expires, heartbeat, started, updated] = this.values;
      Object.assign(job, { status: "running", lease_owner: owner, lease_token_hash: hash, lease_expires_at: expires, heartbeat_at: heartbeat, started_at: job.started_at ?? started, updated_at: updated, error_message: null, attempt_count: job.attempt_count + 1 });
      return { ...job } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET heartbeat_at")) {
      const [heartbeat, expires, progress, updated, jobId, hash, checkedAt] = this.values;
      const job = this.validLease(jobId, hash, checkedAt);
      if (!job || !this.db.attempts.some((item) => item.job_id === jobId && item.lease_token_hash === hash && item.status === "running")) return null;
      Object.assign(job, { heartbeat_at: heartbeat, lease_expires_at: expires, progress_json: progress ?? job.progress_json, updated_at: updated });
      return { cancellation_requested_at: job.cancellation_requested_at } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET status = 'succeeded'")) {
      const [output, completed, updated, jobId, hash, checkedAt] = this.values;
      const job = this.validLease(jobId, hash, checkedAt);
      if (!job || job.cancellation_requested_at || !this.db.attempts.some((item) => item.job_id === jobId && item.lease_token_hash === hash && item.status === "running")) return null;
      Object.assign(job, { status: "succeeded", output_json: output, completed_at: completed, updated_at: updated });
      return { id: job.id } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET\n      status = CASE")) {
      const [requeue, message, , completedAt, cancelledAt, updatedAt, jobId, hash, checkedAt] = this.values;
      const job = this.validLease(jobId, hash, checkedAt);
      if (!job || !this.db.attempts.some((item) => item.job_id === jobId && item.lease_token_hash === hash && item.status === "running")) return null;
      const status = job.cancellation_requested_at ? "cancelled" : requeue === 1 && job.attempt_count < job.max_attempts ? "queued" : "failed";
      Object.assign(job, { status, error_message: message, completed_at: status === "queued" ? null : completedAt, cancelled_at: status === "cancelled" ? cancelledAt : null, updated_at: updatedAt });
      return { status } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET status = 'cancelled'")) {
      const job = this.db.jobs.find((item) => item.id === this.values[4] && item.status === "queued");
      if (!job) return null;
      Object.assign(job, { status: "cancelled", cancellation_requested_at: this.values[0], cancelled_at: this.values[1], completed_at: this.values[2], updated_at: this.values[3] });
      return { id: job.id } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET cancellation_requested_at")) {
      const job = this.db.jobs.find((item) => item.id === this.values[2] && item.status === "running" && !item.cancellation_requested_at);
      if (!job) return null;
      Object.assign(job, { cancellation_requested_at: this.values[0], updated_at: this.values[1] });
      return { id: job.id } as T;
    }
    if (this.sql.startsWith("UPDATE internal_jobs SET status = 'queued'")) {
      const job = this.db.jobs.find((item) => item.id === this.values[2] && ["failed", "cancelled"].includes(item.status));
      if (!job) return null;
      Object.assign(job, { status: "queued", cancellation_requested_at: null, cancelled_at: null, completed_at: null, error_message: null, output_json: null, max_attempts: job.max_attempts <= job.attempt_count ? job.attempt_count + 1 : job.max_attempts });
      return { id: job.id } as T;
    }
    if (this.sql.startsWith("SELECT * FROM internal_jobs")) return (this.db.jobs.find((item) => item.id === this.values[0]) ?? null) as T | null;
    throw new Error(`unsupported first: ${this.sql}`);
  }
  private validLease(jobId: unknown, hash: unknown, checkedAt: unknown) {
    return this.db.jobs.find((item) => item.id === jobId && item.status === "running" && item.lease_token_hash === hash && item.lease_expires_at > String(checkedAt));
  }
  async run() {
    if (this.sql.startsWith("UPDATE internal_job_attempts SET status = 'lease_expired'")) {
      const timestamp = String(this.values[1]);
      this.db.attempts.filter((item) => item.status === "running" && item.lease_expires_at <= timestamp).forEach((item) => Object.assign(item, { status: "lease_expired", finished_at: this.values[0] }));
    } else if (this.sql.includes("runner lease expired after cancellation")) {
      const timestamp = String(this.values[3]);
      this.db.jobs.filter((item) => item.status === "running" && item.lease_expires_at <= timestamp && item.cancellation_requested_at).forEach((item) => Object.assign(item, { status: "cancelled", cancelled_at: this.values[0], completed_at: this.values[1], lease_token_hash: null }));
    } else if (this.sql.includes("maximum attempts were exhausted")) {
      const timestamp = String(this.values[2]);
      this.db.jobs.filter((item) => item.status === "running" && item.lease_expires_at <= timestamp && !item.cancellation_requested_at && item.attempt_count >= item.max_attempts).forEach((item) => Object.assign(item, { status: "failed", completed_at: this.values[0], lease_token_hash: null }));
    } else if (this.sql.startsWith("INSERT INTO internal_job_attempts")) {
      if (this.db.failAttemptInsert) throw new Error("attempt insert failed");
      const [attemptId, jobId, attemptNumber, workerId, hash, leasedAt, expiresAt, heartbeatAt, startedAt] = this.values;
      this.db.attempts.push({ id: attemptId, job_id: jobId, attempt_number: attemptNumber, status: "running", worker_id: workerId, lease_token_hash: hash, leased_at: leasedAt, lease_expires_at: expiresAt, heartbeat_at: heartbeatAt, started_at: startedAt });
    } else if (this.sql.includes("attempt_count = attempt_count - 1")) {
      const job = this.db.jobs.find((item) => item.id === this.values[1] && item.lease_token_hash === this.values[2]);
      if (job) Object.assign(job, { status: "queued", attempt_count: job.attempt_count - 1, lease_owner: null, lease_token_hash: null, lease_expires_at: null });
    } else if (this.sql.startsWith("UPDATE internal_job_attempts SET heartbeat_at")) {
      const attempt = this.db.attempts.find((item) => item.job_id === this.values[2] && item.lease_token_hash === this.values[3]);
      const job = this.db.jobs.find((item) => item.id === this.values[4] && item.status === "running" && item.lease_token_hash === this.values[5] && item.heartbeat_at === this.values[6] && item.lease_expires_at === this.values[7]);
      if (attempt && job) Object.assign(attempt, { heartbeat_at: this.values[0], lease_expires_at: this.values[1] });
    } else if (this.sql.startsWith("UPDATE internal_job_attempts SET status = 'succeeded'")) {
      const attempt = this.db.attempts.find((item) => item.job_id === this.values[2] && item.lease_token_hash === this.values[3]);
      if (attempt) Object.assign(attempt, { status: "succeeded", output_json: this.values[0], finished_at: this.values[1] });
    } else if (this.sql.startsWith("UPDATE internal_job_attempts SET status = CASE")) {
      const [jobId, hash, message, finishedAt] = this.values;
      const job = this.db.jobs.find((item) => item.id === jobId && item.lease_token_hash === hash)!;
      const attempt = this.db.attempts.find((item) => item.job_id === jobId && item.lease_token_hash === hash);
      if (job && attempt) Object.assign(attempt, { status: job.status === "cancelled" ? "cancelled" : "failed", error_message: message, finished_at: finishedAt });
    } else if (this.sql.startsWith("UPDATE internal_jobs SET lease_owner = NULL")) {
      const job = this.db.jobs.find((item) => item.id === this.values[0] && item.lease_token_hash === this.values[1]);
      if (job) Object.assign(job, { lease_owner: null, lease_token_hash: null, lease_expires_at: null });
    } else throw new Error(`unsupported run: ${this.sql}`);
    return { success: true };
  }
}

class MemoryJobs {
  jobs: Row[] = [job()];
  attempts: Row[] = [];
  failAttemptInsert = false;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) {
    return Promise.all(statements.map(async (statement) => {
      if ((statement as any).sql.includes("RETURNING")) {
        const row = await statement.first<Row>();
        return { success: true, results: row ? [row] : [] };
      }
      await statement.run();
      return { success: true, results: [] };
    }));
  }
}

class MemoryDatasetStatement {
  constructor(private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new MemoryDatasetStatement(this.sql, values); }
  async first<T>() {
    if (this.sql.startsWith("SELECT id, status FROM dataset_versions") && this.values[0] === "dsv_1") return { id: "dsv_1", status: "frozen" } as T;
    return null;
  }
  async all<T>() {
    if (this.sql.startsWith("SELECT id, source_url AS url") && this.values[0] === "dsv_1") return { results: [{ id: "src_1", url: "https://media.example/video.mp4", display_name: "Video", ordinal: 0 }] as T[] };
    return { results: [] as T[] };
  }
}

function job(overrides: Row = {}): Row {
  return { id: "job_1", job_type: "sampling", status: "queued", input_json: "{}", progress_json: null, output_json: null, error_message: null, attempt_count: 0, max_attempts: 3, created_at: "2026-10-02T00:00:00.000Z", started_at: null, completed_at: null, updated_at: "2026-10-02T00:00:00.000Z", cancellation_requested_at: null, ...overrides };
}
function environment(database = new MemoryJobs()): AdjudicationEnv {
  return { CONTROL_DB: database as unknown as D1Database, DATASET_DB: { prepare: (sql: string) => new MemoryDatasetStatement(sql) } as unknown as D1Database, REVIEW_BUCKET: {} as R2Bucket, INTERNAL_ARTIFACTS_BUCKET: {} as R2Bucket, ADMIN_TOKEN: "admin", RUNNER_TOKEN: "runner", ASSETS: {} as Fetcher };
}
const request = (path: string, payload: unknown, token = "runner", lease?: string) => new Request(`https://internal.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(lease ? { "x-job-lease-token": lease } : {}) }, body: JSON.stringify(payload) });
const get = (path: string, token = "runner") => new Request(`https://internal.test${path}`, { headers: { authorization: `Bearer ${token}` } });

async function claim(database: MemoryJobs) {
  const response = await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/claim", { runner_id: "runner-1", lease_seconds: 60 }), environment(database));
  return { response: response!, payload: await response!.json() as any };
}

describe("sampling job lifecycle", () => {
  it("claims and heartbeats without storing the raw lease or trusting metadata completion", async () => {
    const database = new MemoryJobs(), claimed = await claim(database);
    expect(claimed.response.status).toBe(200);
    expect(database.jobs[0].lease_token_hash).not.toBe(claimed.payload.data.lease_token);
    expect(database.attempts).toHaveLength(1);
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/job_1/heartbeat", { progress: { frames: 4 } }, "runner", claimed.payload.data.lease_token), environment(database)))?.status).toBe(200);
    expect(claimed.payload.data.frame_set_id).toBe("frameset_1");
    const completion = await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/job_1/complete", { output: { report_key: "reports/job_1.json" } }, "runner", claimed.payload.data.lease_token), environment(database));
    expect(completion?.status).toBe(409);
    expect((await completion!.json() as any).error.code).toBe("frame_set_required");
    expect(database.jobs[0]).toEqual(expect.objectContaining({ status: "running" }));
    expect(database.attempts[0].status).toBe("running");
  });

  it("terminalizes abandoned cancelled and exhausted leases", async () => {
    const expired = "2000-01-01T00:00:00.000Z";
    const database = new MemoryJobs();
    database.jobs = [job({ id: "cancelled", status: "running", lease_expires_at: expired, lease_token_hash: "a", attempt_count: 1, cancellation_requested_at: expired }), job({ id: "exhausted", status: "running", lease_expires_at: expired, lease_token_hash: "b", attempt_count: 3, max_attempts: 3 })];
    database.attempts = [{ job_id: "cancelled", status: "running", lease_expires_at: expired }, { job_id: "exhausted", status: "running", lease_expires_at: expired }];
    await claim(database);
    expect(database.jobs.map((item) => item.status)).toEqual(["cancelled", "failed"]);
    expect(database.attempts.every((item) => item.status === "lease_expired")).toBe(true);
  });

  it("compensates when attempt creation fails", async () => {
    const database = new MemoryJobs(); database.failAttemptInsert = true;
    await expect(claim(database)).rejects.toThrow("attempt insert failed");
    expect(database.jobs[0]).toEqual(expect.objectContaining({ status: "queued", attempt_count: 0, lease_token_hash: null }));
  });

  it("rejects stale leases and completion after cancellation", async () => {
    const database = new MemoryJobs(), claimed = await claim(database), env = environment(database);
    await handleAdminJobAction(request("/api/internal/v1/sampling-jobs/job_1/cancel", {}, "admin"), env);
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/job_1/complete", { output: {} }, "runner", claimed.payload.data.lease_token), env))?.status).toBe(409);
    database.jobs[0].lease_expires_at = "2000-01-01T00:00:00.000Z";
    const attemptExpiry = database.attempts[0].lease_expires_at;
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/job_1/heartbeat", {}, "runner", claimed.payload.data.lease_token), env))?.status).toBe(409);
    expect(database.attempts[0].lease_expires_at).toBe(attemptExpiry);
  });

  it("supports state-conditional administrator cancellation and retry", async () => {
    const database = new MemoryJobs(), env = environment(database);
    expect((await handleAdminJobAction(request("/api/internal/v1/sampling-jobs/job_1/cancel", {}, "admin"), env))?.status).toBe(200);
    expect((await handleAdminJobAction(request("/api/internal/v1/sampling-jobs/job_1/retry", {}, "admin"), env))?.status).toBe(200);
    database.jobs[0].status = "succeeded";
    expect((await handleAdminJobAction(request("/api/internal/v1/sampling-jobs/job_1/cancel", {}, "admin"), env))?.status).toBe(409);
  });

  it("rejects missing auth, malformed ids, and invalid leases", async () => {
    const env = environment();
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/claim", { runner_id: "runner-1" }, "wrong"), env))?.status).toBe(401);
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/%ZZ/heartbeat", {}, "runner", "wrong"), env))?.status).toBe(400);
    expect((await handleRunnerApi(request("/api/internal/v1/runner/sampling-jobs/job_1/heartbeat", {}, "runner", "wrong"), env))?.status).toBe(409);
  });

  it("provides frozen dataset sources only to the runner", async () => {
    const env = environment();
    const response = await handleRunnerApi(get("/api/internal/v1/runner/dataset-versions/dsv_1/sources"), env);
    expect(response?.status).toBe(200);
    expect((await response!.json() as any).data.sources).toEqual([{ id: "src_1", url: "https://media.example/video.mp4", display_name: "Video", ordinal: 0 }]);
    expect((await handleRunnerApi(get("/api/internal/v1/runner/dataset-versions/dsv_1/sources", "wrong"), env))?.status).toBe(401);
    expect((await handleRunnerApi(get("/api/internal/v1/runner/dataset-versions/missing/sources"), env))?.status).toBe(404);
  });
});
