/** @type implementation @purpose Track runner availability from authenticated claims and lease heartbeats. */
import type { AdjudicationEnv } from "./types";

export const RUNNER_PRESENCE_TTL_SECONDS = 360;

export type RunnerPresenceStatus = "available" | "busy";

export async function recordRunnerPresence(
  env: AdjudicationEnv,
  runnerId: string,
  status: RunnerPresenceStatus,
  currentJobId: string | null,
  timestamp = new Date().toISOString(),
): Promise<void> {
  const expiresAt = new Date(Date.parse(timestamp) + RUNNER_PRESENCE_TTL_SECONDS * 1000).toISOString();
  await env.CONTROL_DB.prepare(`INSERT INTO runner_presence (runner_id, status, current_job_id, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(runner_id) DO UPDATE SET
      status = excluded.status,
      current_job_id = excluded.current_job_id,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at`)
    .bind(runnerId, status, currentJobId, timestamp, expiresAt).run();
}

export async function recordIdleRunnerPresence(
  env: AdjudicationEnv,
  runnerId: string,
  timestamp = new Date().toISOString(),
): Promise<void> {
  const expiresAt = new Date(Date.parse(timestamp) + RUNNER_PRESENCE_TTL_SECONDS * 1000).toISOString();
  await env.CONTROL_DB.prepare(`INSERT INTO runner_presence (runner_id, status, current_job_id, last_seen_at, expires_at)
    VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM internal_jobs WHERE lease_owner = ? AND status = 'running' AND lease_expires_at > ?) THEN 'busy' ELSE 'available' END,
      (SELECT id FROM internal_jobs WHERE lease_owner = ? AND status = 'running' AND lease_expires_at > ? ORDER BY id LIMIT 1), ?, ?)
    ON CONFLICT(runner_id) DO UPDATE SET
      status = CASE WHEN EXISTS (SELECT 1 FROM internal_jobs WHERE lease_owner = excluded.runner_id AND status = 'running' AND lease_expires_at > excluded.last_seen_at) THEN 'busy' ELSE 'available' END,
      current_job_id = (SELECT id FROM internal_jobs WHERE lease_owner = excluded.runner_id AND status = 'running' AND lease_expires_at > excluded.last_seen_at ORDER BY id LIMIT 1),
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at`)
    .bind(runnerId, runnerId, timestamp, runnerId, timestamp, timestamp, expiresAt).run();
}

export function runnerAvailabilityAfterJobStatement(
  env: AdjudicationEnv,
  jobId: string,
  timestamp: string,
): D1PreparedStatement {
  const expiresAt = new Date(Date.parse(timestamp) + RUNNER_PRESENCE_TTL_SECONDS * 1000).toISOString();
  return env.CONTROL_DB.prepare(`UPDATE runner_presence SET status = 'available', current_job_id = NULL, last_seen_at = ?, expires_at = ?
    WHERE current_job_id = ? AND status = 'busy'`)
    .bind(timestamp, expiresAt, jobId);
}

export async function listRunnerPresence(env: AdjudicationEnv): Promise<{
  available_count: number;
  busy_count: number;
  total_count: number;
  heartbeat_ttl_seconds: number;
  runners: Array<{ runner_id: string; status: RunnerPresenceStatus; current_job_id: string | null; last_seen_at: string; expires_at: string }>;
}> {
  const now = new Date().toISOString();
  const rows = await env.CONTROL_DB.prepare(`SELECT runner_id, status, current_job_id, last_seen_at, expires_at
    FROM runner_presence WHERE expires_at > ? ORDER BY status, runner_id`)
    .bind(now).all<{ runner_id: string; status: RunnerPresenceStatus; current_job_id: string | null; last_seen_at: string; expires_at: string }>();
  const runners = rows.results ?? [];
  const availableCount = runners.filter((runner) => runner.status === "available").length;
  const busyCount = runners.filter((runner) => runner.status === "busy").length;
  return {
    available_count: availableCount,
    busy_count: busyCount,
    total_count: runners.length,
    heartbeat_ttl_seconds: RUNNER_PRESENCE_TTL_SECONDS,
    runners,
  };
}
