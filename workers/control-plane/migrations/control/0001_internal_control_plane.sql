-- Transactional metadata for internal jobs and model/pipeline governance.
-- IDs owned by the dataset database are intentionally stored as opaque values:
-- SQLite foreign keys cannot enforce relationships across D1 databases.
PRAGMA foreign_keys = ON;

CREATE TABLE internal_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE internal_user_roles (
  user_id TEXT NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'researcher', 'review_coordinator', 'reviewer', 'adjudicator', 'release_approver')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('source_video', 'frame_manifest', 'frame_image', 'template', 'submission', 'comparison', 'ground_truth', 'model', 'evaluation_report', 'capsule')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  media_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE internal_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('sampling', 'template_generation', 'validation', 'evaluation')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL,
  progress_json TEXT,
  output_json TEXT,
  error_message TEXT,
  requested_by TEXT REFERENCES internal_users(id),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX internal_jobs_status_idx ON internal_jobs(status, created_at);

CREATE TABLE frame_sets (
  id TEXT PRIMARY KEY,
  dataset_version_id TEXT NOT NULL,
  sampling_job_id TEXT NOT NULL UNIQUE REFERENCES internal_jobs(id),
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  source_count INTEGER NOT NULL CHECK (source_count > 0),
  frame_count INTEGER NOT NULL CHECK (frame_count > 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'invalid', 'archived')),
  created_at TEXT NOT NULL
);
CREATE INDEX frame_sets_dataset_version_idx ON frame_sets(dataset_version_id, created_at);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES policies(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'deprecated', 'retired')),
  definition_json TEXT NOT NULL,
  instructions_artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (policy_id, version)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  frame_set_id TEXT NOT NULL REFERENCES frame_sets(id),
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id),
  generation_job_id TEXT UNIQUE REFERENCES internal_jobs(id),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'invalid', 'superseded', 'archived')),
  frame_count INTEGER NOT NULL CHECK (frame_count > 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE review_campaigns (
  id TEXT PRIMARY KEY,
  legacy_review_id TEXT UNIQUE,
  name TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES templates(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'active', 'awaiting_adjudication', 'adjudicating', 'completed', 'cancelled')),
  created_by TEXT REFERENCES internal_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE ground_truth_versions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL UNIQUE REFERENCES review_campaigns(id),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
  validation_job_id TEXT REFERENCES internal_jobs(id),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validating', 'valid', 'invalid', 'approved', 'superseded')),
  approved_by TEXT REFERENCES internal_users(id),
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id),
  version TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
  configuration_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'candidate', 'validated', 'approved', 'production', 'retired', 'rejected')),
  created_at TEXT NOT NULL,
  UNIQUE (model_id, version)
);

CREATE TABLE pipeline_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  configuration_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'candidate', 'approved', 'active', 'superseded', 'rolled_back')),
  approved_by TEXT REFERENCES internal_users(id),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  activated_at TEXT
);

CREATE TABLE evaluation_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES internal_jobs(id),
  ground_truth_version_id TEXT NOT NULL REFERENCES ground_truth_versions(id),
  model_version_id TEXT REFERENCES model_versions(id),
  pipeline_release_id TEXT REFERENCES pipeline_releases(id),
  report_artifact_id TEXT REFERENCES artifacts(id),
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE pipeline_release_evaluations (
  pipeline_release_id TEXT NOT NULL REFERENCES pipeline_releases(id) ON DELETE CASCADE,
  evaluation_run_id TEXT NOT NULL REFERENCES evaluation_runs(id),
  PRIMARY KEY (pipeline_release_id, evaluation_run_id)
);

CREATE TABLE internal_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT REFERENCES internal_users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX internal_audit_resource_idx ON internal_audit_events(resource_type, resource_id, created_at);
