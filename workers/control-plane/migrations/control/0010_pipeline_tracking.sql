PRAGMA foreign_keys = ON;

CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_by TEXT REFERENCES internal_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pipelines_created_idx ON pipelines(created_at DESC, id DESC);

CREATE TABLE pipeline_resources (
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'dataset', 'dataset_version', 'sampling_job', 'frame_set', 'template',
    'review_campaign', 'evaluation_run', 'model_version', 'pipeline_release'
  )),
  resource_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_id, resource_type, resource_id)
);
CREATE INDEX pipeline_resources_resource_idx ON pipeline_resources(resource_type, resource_id);
CREATE TRIGGER pipeline_resources_limit
BEFORE INSERT ON pipeline_resources
WHEN (SELECT COUNT(*) FROM pipeline_resources WHERE pipeline_id = NEW.pipeline_id) >= 100
BEGIN
  SELECT RAISE(ABORT, 'pipeline_resource_limit');
END;
