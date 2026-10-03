-- Durable execution metadata for safely claiming and retrying internal jobs.
-- Timestamps are UTC ISO-8601 strings so their lexical ordering is chronological.
PRAGMA foreign_keys = ON;

-- A caller may reuse an idempotency key for the same job type to recover the
-- original job rather than enqueueing duplicate work.
ALTER TABLE internal_jobs ADD COLUMN idempotency_key TEXT;

-- available_at supports delayed initial execution and retry backoff. A NULL
-- value means the job is immediately eligible while it is queued.
ALTER TABLE internal_jobs ADD COLUMN available_at TEXT;

-- A worker owns a running job only while the SHA-256 hash of its presented
-- one-time lease token matches and lease_expires_at is in the future. Raw lease
-- secrets are never persisted. attempt_count is incremented atomically when the
-- lease is acquired; max_attempts bounds automatic retries.
ALTER TABLE internal_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE internal_jobs ADD COLUMN lease_token_hash TEXT;
ALTER TABLE internal_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE internal_jobs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE internal_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE internal_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0);

-- Cancellation is cooperative: a requester records intent, and the worker
-- records acknowledgement after stopping. Queued work can be cancelled without
-- ever acquiring a lease.
ALTER TABLE internal_jobs ADD COLUMN cancellation_requested_at TEXT;
ALTER TABLE internal_jobs ADD COLUMN cancellation_requested_by TEXT REFERENCES internal_users(id);
ALTER TABLE internal_jobs ADD COLUMN cancellation_reason TEXT;
ALTER TABLE internal_jobs ADD COLUMN cancelled_at TEXT;

-- Retry request metadata records the latest explicit request. Full execution
-- history remains append-only in internal_job_attempts.
ALTER TABLE internal_jobs ADD COLUMN retry_requested_at TEXT;
ALTER TABLE internal_jobs ADD COLUMN retry_requested_by TEXT REFERENCES internal_users(id);

CREATE UNIQUE INDEX internal_jobs_idempotency_idx
  ON internal_jobs(job_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX internal_jobs_lease_token_hash_idx
  ON internal_jobs(lease_token_hash)
  WHERE lease_token_hash IS NOT NULL;

-- Supports selecting the next eligible queued job before an atomic conditional
-- UPDATE claims it. The UPDATE must still recheck status, availability, attempt
-- limit, cancellation, and lease expiry to handle competing workers safely.
CREATE INDEX internal_jobs_claim_idx
  ON internal_jobs(status, available_at, created_at)
  WHERE cancellation_requested_at IS NULL;

CREATE INDEX internal_jobs_expired_lease_idx
  ON internal_jobs(status, lease_expires_at)
  WHERE status = 'running';

CREATE TABLE internal_job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES internal_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'lease_expired', 'cancelled')),
  worker_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL UNIQUE,
  leased_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  output_json TEXT,
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX internal_job_attempts_job_idx
  ON internal_job_attempts(job_id, attempt_number);

CREATE INDEX internal_job_attempts_expired_lease_idx
  ON internal_job_attempts(status, lease_expires_at)
  WHERE status = 'running';
