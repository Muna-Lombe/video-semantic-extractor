/** @type implementation @purpose Coordinate durable sampling-job leases and lifecycle transitions. */
import type { AdjudicationEnv } from "./types";

type JsonRecord = Record<string, unknown>;
const MAX_BODY_BYTES = 64 * 1024;

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function body(request: Request): Promise<JsonRecord | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error("unsupported_media_type", "content-type must be application/json", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : error("invalid_request", "request body must be a JSON object", 400);
  } catch {
    return error("invalid_json", "request body is not valid JSON", 400);
  }
}

function exactKeys(value: JsonRecord, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function decodeId(value: string): string | Response {
  try {
    const decoded = decodeURIComponent(value);
    return /^[a-zA-Z0-9_-]{1,100}$/.test(decoded) ? decoded : error("invalid_id", "job id is invalid", 400);
  } catch {
    return error("invalid_id", "job id is invalid", 400);
  }
}

function runnerAuthorized(request: Request, env: AdjudicationEnv): boolean {
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return Boolean(env.RUNNER_TOKEN && supplied === env.RUNNER_TOKEN);
}

function publicJob(row: JsonRecord) {
  return {
    id: row.id, type: row.job_type, status: row.status,
    input: JSON.parse(String(row.input_json)),
    progress: row.progress_json == null ? null : JSON.parse(String(row.progress_json)),
    output: row.output_json == null ? null : JSON.parse(String(row.output_json)),
    error_message: row.error_message, attempt_count: row.attempt_count,
    max_attempts: row.max_attempts, lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at, heartbeat_at: row.heartbeat_at,
    cancellation_requested_at: row.cancellation_requested_at,
    created_at: row.created_at, started_at: row.started_at,
    completed_at: row.completed_at, updated_at: row.updated_at,
  };
}

function returnedRow(result: D1Result<JsonRecord> | undefined): JsonRecord | null {
  return result?.results?.[0] ?? null;
}

async function sweepExpired(env: AdjudicationEnv, timestamp: string): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = 'lease_expired', finished_at = ?, error_message = 'runner lease expired' WHERE status = 'running' AND lease_expires_at <= ?").bind(timestamp, timestamp),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'cancelled', error_message = 'runner lease expired after cancellation request', cancelled_at = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE job_type = 'sampling' AND status = 'running' AND lease_expires_at <= ? AND cancellation_requested_at IS NOT NULL").bind(timestamp, timestamp, timestamp, timestamp),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'failed', error_message = 'runner lease expired and maximum attempts were exhausted', completed_at = ?, updated_at = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE job_type = 'sampling' AND status = 'running' AND lease_expires_at <= ? AND cancellation_requested_at IS NULL AND attempt_count >= max_attempts").bind(timestamp, timestamp, timestamp),
  ]);
}

async function claim(request: Request, env: AdjudicationEnv): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["runner_id", "lease_seconds"]) || typeof value.runner_id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.runner_id)) return error("invalid_request", "runner_id must contain 1-100 letters, digits, dots, underscores, or hyphens", 400);
  const leaseSeconds = value.lease_seconds ?? 300;
  if (!Number.isInteger(leaseSeconds) || Number(leaseSeconds) < 30 || Number(leaseSeconds) > 900) return error("invalid_request", "lease_seconds must be an integer from 30 through 900", 400);
  const claimedAt = now(), expiresAt = new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString();
  await sweepExpired(env, claimedAt);
  const leaseToken = `${crypto.randomUUID()}${crypto.randomUUID()}`, leaseHash = await digest(leaseToken);
  const row = await env.CONTROL_DB.prepare(`UPDATE internal_jobs SET status = 'running', lease_owner = ?, lease_token_hash = ?, lease_expires_at = ?, heartbeat_at = ?, attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ?, error_message = NULL
    WHERE id = (SELECT id FROM internal_jobs WHERE job_type = 'sampling' AND cancellation_requested_at IS NULL AND attempt_count < max_attempts AND ((status = 'queued' AND (available_at IS NULL OR available_at <= ?)) OR (status = 'running' AND lease_expires_at <= ?)) ORDER BY created_at, id LIMIT 1)
    RETURNING *`).bind(value.runner_id, leaseHash, expiresAt, claimedAt, claimedAt, claimedAt, claimedAt, claimedAt).first<JsonRecord>();
  if (!row) return json({ data: null });
  const attemptId = id("attempt");
  try {
    await env.CONTROL_DB.prepare("INSERT INTO internal_job_attempts (id, job_id, attempt_number, status, worker_id, lease_token_hash, leased_at, lease_expires_at, heartbeat_at, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)")
      .bind(attemptId, row.id, row.attempt_count, value.runner_id, leaseHash, claimedAt, expiresAt, claimedAt, claimedAt).run();
  } catch (cause) {
    await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'queued', attempt_count = attempt_count - 1, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_token_hash = ?")
      .bind(now(), row.id, leaseHash).run();
    throw cause;
  }
  return json({ data: { job: publicJob(row), attempt_id: attemptId, lease_token: leaseToken, lease_expires_at: expiresAt } });
}

async function heartbeat(request: Request, env: AdjudicationEnv, jobId: string): Promise<Response> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const value = await body(request);
  if (value instanceof Response) return value;
  if (!exactKeys(value, ["lease_seconds", "progress"])) return error("invalid_request", "request contains unknown fields", 400);
  const leaseSeconds = value.lease_seconds ?? 300;
  if (!Number.isInteger(leaseSeconds) || Number(leaseSeconds) < 30 || Number(leaseSeconds) > 900) return error("invalid_request", "lease_seconds must be an integer from 30 through 900", 400);
  if (value.progress !== undefined && (!value.progress || typeof value.progress !== "object" || Array.isArray(value.progress))) return error("invalid_request", "progress must be an object", 400);
  const hash = await digest(token), timestamp = now(), expiresAt = new Date(Date.now() + Number(leaseSeconds) * 1000).toISOString();
  const results = await env.CONTROL_DB.batch<JsonRecord>([
    env.CONTROL_DB.prepare(`UPDATE internal_jobs SET heartbeat_at = ?, lease_expires_at = ?, progress_json = COALESCE(?, progress_json), updated_at = ?
      WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
      RETURNING cancellation_requested_at`).bind(timestamp, expiresAt, value.progress === undefined ? null : JSON.stringify(value.progress), timestamp, jobId, hash, timestamp, hash),
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET heartbeat_at = ?, lease_expires_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running' AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'running' AND lease_token_hash = ? AND heartbeat_at = ? AND lease_expires_at = ?)").bind(timestamp, expiresAt, jobId, hash, jobId, hash, timestamp, expiresAt),
  ]);
  const row = returnedRow(results[0]);
  if (!row) return error("invalid_lease", "job lease is invalid or expired", 409);
  return json({ data: { id: jobId, lease_expires_at: expiresAt, cancellation_requested: Boolean(row.cancellation_requested_at) } });
}

async function finish(request: Request, env: AdjudicationEnv, jobId: string, action: "complete" | "fail"): Promise<Response> {
  const token = request.headers.get("x-job-lease-token");
  if (!token) return error("lease_required", "X-Job-Lease-Token is required", 401);
  const value = await body(request);
  if (value instanceof Response) return value;
  const hash = await digest(token), timestamp = now();
  if (action === "complete") {
    if (!exactKeys(value, ["output"]) || !value.output || typeof value.output !== "object" || Array.isArray(value.output)) return error("invalid_request", "output must be an object", 400);
    const output = JSON.stringify(value.output);
    const results = await env.CONTROL_DB.batch<JsonRecord>([
      env.CONTROL_DB.prepare(`UPDATE internal_jobs SET status = 'succeeded', output_json = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ? AND cancellation_requested_at IS NULL
          AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
        RETURNING id`).bind(output, timestamp, timestamp, jobId, hash, timestamp, hash),
      env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = 'succeeded', output_json = ?, finished_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running' AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'succeeded' AND lease_token_hash = ?)").bind(output, timestamp, jobId, hash, jobId, hash),
      env.CONTROL_DB.prepare("UPDATE internal_jobs SET lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'succeeded' AND lease_token_hash = ?").bind(jobId, hash),
    ]);
    const row = returnedRow(results[0]);
    if (!row) return error("invalid_lease", "job lease is invalid, expired, or cancellation was requested", 409);
    return json({ data: { id: jobId, status: "succeeded", output: value.output } });
  }
  if (!exactKeys(value, ["error_message", "requeue"]) || typeof value.error_message !== "string" || value.error_message.trim().length < 1 || value.error_message.length > 2000 || (value.requeue !== undefined && typeof value.requeue !== "boolean")) return error("invalid_request", "error_message is required and requeue must be boolean", 400);
  const results = await env.CONTROL_DB.batch<JsonRecord>([
    env.CONTROL_DB.prepare(`UPDATE internal_jobs SET
        status = CASE WHEN cancellation_requested_at IS NOT NULL THEN 'cancelled' WHEN ? = 1 AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
        error_message = ?, completed_at = CASE WHEN cancellation_requested_at IS NULL AND ? = 1 AND attempt_count < max_attempts THEN NULL ELSE ? END,
        cancelled_at = CASE WHEN cancellation_requested_at IS NOT NULL THEN ? ELSE NULL END, updated_at = ?
      WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND lease_token_hash = ? AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM internal_job_attempts WHERE job_id = internal_jobs.id AND lease_token_hash = ? AND status = 'running')
      RETURNING status`).bind(value.requeue === true ? 1 : 0, value.error_message.trim(), value.requeue === true ? 1 : 0, timestamp, timestamp, timestamp, jobId, hash, timestamp, hash),
    env.CONTROL_DB.prepare("UPDATE internal_job_attempts SET status = CASE WHEN EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status = 'cancelled' AND lease_token_hash = ?) THEN 'cancelled' ELSE 'failed' END, error_message = ?, finished_at = ? WHERE job_id = ? AND lease_token_hash = ? AND status = 'running' AND EXISTS (SELECT 1 FROM internal_jobs WHERE id = ? AND status IN ('queued', 'failed', 'cancelled') AND lease_token_hash = ?)").bind(jobId, hash, value.error_message.trim(), timestamp, jobId, hash, jobId, hash),
    env.CONTROL_DB.prepare("UPDATE internal_jobs SET lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token_hash = ? AND status IN ('queued', 'failed', 'cancelled')").bind(jobId, hash),
  ]);
  const row = returnedRow(results[0]);
  if (!row) return error("invalid_lease", "job lease is invalid or expired", 409);
  return json({ data: { id: jobId, status: row.status, requeued: row.status === "queued" } });
}

export async function handleRunnerApi(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/internal/v1/runner/")) return null;
  if (!env.RUNNER_TOKEN) return error("runner_unavailable", "runner authentication is not configured", 503);
  if (!runnerAuthorized(request, env)) return error("unauthorized", "runner bearer token required", 401);
  if (path === "/api/internal/v1/runner/sampling-jobs/claim") return request.method === "POST" ? claim(request, env) : error("method_not_allowed", "method not allowed", 405);
  const match = path.match(/^\/api\/internal\/v1\/runner\/sampling-jobs\/([^/]+)\/(heartbeat|complete|fail)$/);
  if (!match) return null;
  if (request.method !== "POST") return error("method_not_allowed", "method not allowed", 405);
  const jobId = decodeId(match[1]);
  if (jobId instanceof Response) return jobId;
  if (match[2] === "heartbeat") return heartbeat(request, env, jobId);
  return finish(request, env, jobId, match[2] as "complete" | "fail");
}

async function currentJob(env: AdjudicationEnv, jobId: string): Promise<JsonRecord | null> {
  return env.CONTROL_DB.prepare("SELECT * FROM internal_jobs WHERE id = ? AND job_type = 'sampling'").bind(jobId).first<JsonRecord>();
}

export async function handleAdminJobAction(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const match = path.match(/^\/api\/internal\/v1\/sampling-jobs\/([^/]+)\/(cancel|retry)$/);
  if (!match) return null;
  if (request.method !== "POST") return error("method_not_allowed", "method not allowed", 405);
  const jobId = decodeId(match[1]);
  if (jobId instanceof Response) return jobId;
  const timestamp = now();
  if (match[2] === "cancel") {
    const queued = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'cancelled', cancellation_requested_at = ?, cancellation_reason = 'administrator request', cancelled_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND job_type = 'sampling' AND status = 'queued' RETURNING id")
      .bind(timestamp, timestamp, timestamp, timestamp, jobId).first<JsonRecord>();
    if (queued) return json({ data: { id: jobId, status: "cancelled", cancellation_requested: false } });
    const running = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET cancellation_requested_at = ?, cancellation_reason = 'administrator request', updated_at = ? WHERE id = ? AND job_type = 'sampling' AND status = 'running' AND cancellation_requested_at IS NULL RETURNING id")
      .bind(timestamp, timestamp, jobId).first<JsonRecord>();
    if (running) return json({ data: { id: jobId, status: "running", cancellation_requested: true } });
    const row = await currentJob(env, jobId);
    if (!row) return error("not_found", "sampling job not found", 404);
    if (row.status === "cancelled") return json({ data: { id: jobId, status: "cancelled", cancellation_requested: false } });
    if (row.status === "running" && row.cancellation_requested_at) return json({ data: { id: jobId, status: "running", cancellation_requested: true } });
    return error("invalid_state", "only queued or running jobs can be cancelled", 409);
  }
  const retried = await env.CONTROL_DB.prepare("UPDATE internal_jobs SET status = 'queued', available_at = NULL, cancellation_requested_at = NULL, cancellation_reason = NULL, cancelled_at = NULL, completed_at = NULL, error_message = NULL, output_json = NULL, retry_requested_at = ?, max_attempts = CASE WHEN max_attempts <= attempt_count THEN attempt_count + 1 ELSE max_attempts END, updated_at = ? WHERE id = ? AND job_type = 'sampling' AND status IN ('failed', 'cancelled') RETURNING id")
    .bind(timestamp, timestamp, jobId).first<JsonRecord>();
  if (retried) return json({ data: { id: jobId, status: "queued" } });
  const row = await currentJob(env, jobId);
  return row ? error("invalid_state", "only failed or cancelled jobs can be retried", 409) : error("not_found", "sampling job not found", 404);
}
