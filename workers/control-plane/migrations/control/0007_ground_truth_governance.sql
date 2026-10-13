-- Immutable validation reports and human decisions, separate from candidate bytes.
ALTER TABLE ground_truth_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ground_truth_versions ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (approval_status IN ('pending', 'approved', 'rejected', 'superseded'));
ALTER TABLE ground_truth_versions ADD COLUMN approval_scope TEXT CHECK (approval_scope IS NULL OR approval_scope = 'diagnostic');
ALTER TABLE ground_truth_versions ADD COLUMN superseded_by_id TEXT REFERENCES ground_truth_versions(id);
ALTER TABLE ground_truth_versions ADD COLUMN last_operation_id TEXT;

CREATE TABLE ground_truth_validations (
  id TEXT PRIMARY KEY,
  ground_truth_id TEXT NOT NULL REFERENCES ground_truth_versions(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES internal_jobs(id),
  candidate_sha256 TEXT NOT NULL,
  template_sha256 TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  report_storage_key TEXT NOT NULL UNIQUE,
  report_sha256 TEXT NOT NULL,
  report_size_bytes INTEGER NOT NULL CHECK (report_size_bytes > 0),
  created_at TEXT NOT NULL
);
ALTER TABLE ground_truth_versions ADD COLUMN latest_validation_id TEXT REFERENCES ground_truth_validations(id);

CREATE TABLE ground_truth_decisions (
  id TEXT PRIMARY KEY,
  ground_truth_id TEXT NOT NULL REFERENCES ground_truth_versions(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'supersede')),
  actor_reference TEXT NOT NULL,
  reason TEXT NOT NULL,
  attestation_json TEXT,
  validation_id TEXT REFERENCES ground_truth_validations(id),
  candidate_sha256 TEXT NOT NULL,
  replacement_id TEXT REFERENCES ground_truth_versions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX ground_truth_validations_version_idx ON ground_truth_validations(ground_truth_id, created_at, id);
CREATE INDEX ground_truth_decisions_version_idx ON ground_truth_decisions(ground_truth_id, created_at, id);
CREATE INDEX ground_truth_created_idx ON ground_truth_versions(created_at, id);
