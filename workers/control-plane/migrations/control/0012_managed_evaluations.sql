-- Freeze the full input lineage for durable diagnostic evaluation jobs.
ALTER TABLE evaluation_runs ADD COLUMN input_sha256 TEXT;
ALTER TABLE evaluation_runs ADD COLUMN implementation_version TEXT;
ALTER TABLE evaluation_runs ADD COLUMN created_by TEXT REFERENCES internal_users(id);
ALTER TABLE evaluation_runs ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX evaluation_runs_idempotency_idx
  ON evaluation_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX evaluation_runs_ground_truth_idx
  ON evaluation_runs(ground_truth_version_id, created_at DESC, id DESC);
CREATE INDEX evaluation_runs_model_idx
  ON evaluation_runs(model_version_id, created_at DESC, id DESC);
