-- Lease-bound sampling artifacts and relational frame-set membership.
PRAGMA foreign_keys = ON;

CREATE TABLE artifact_uploads (
  id TEXT PRIMARY KEY,
  sampling_job_id TEXT NOT NULL REFERENCES internal_jobs(id) ON DELETE CASCADE,
  lease_token_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('frame_image')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'uploaded', 'finalized')),
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  finalized_at TEXT
);
CREATE INDEX artifact_uploads_job_idx ON artifact_uploads(sampling_job_id, status, created_at);

ALTER TABLE frame_sets ADD COLUMN manifest_schema_version TEXT;
ALTER TABLE frame_sets ADD COLUMN engine_name TEXT;
ALTER TABLE frame_sets ADD COLUMN engine_version TEXT;
ALTER TABLE frame_sets ADD COLUMN engine_configuration_sha256 TEXT;
ALTER TABLE frame_sets ADD COLUMN finalized_by_lease_hash TEXT;
CREATE UNIQUE INDEX frame_sets_finalization_lease_idx
  ON frame_sets(sampling_job_id, finalized_by_lease_hash)
  WHERE finalized_by_lease_hash IS NOT NULL;

CREATE TABLE frame_set_sources (
  frame_set_id TEXT NOT NULL REFERENCES frame_sets(id) ON DELETE CASCADE,
  dataset_source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
  PRIMARY KEY (frame_set_id, dataset_source_id),
  UNIQUE (frame_set_id, ordinal)
);

CREATE TABLE frame_set_frames (
  id TEXT PRIMARY KEY,
  frame_set_id TEXT NOT NULL REFERENCES frame_sets(id) ON DELETE CASCADE,
  dataset_source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  timestamp_seconds REAL NOT NULL CHECK (timestamp_seconds >= 0),
  reasons_json TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  UNIQUE (frame_set_id, dataset_source_id, ordinal),
  FOREIGN KEY (frame_set_id, dataset_source_id)
    REFERENCES frame_set_sources(frame_set_id, dataset_source_id)
);
CREATE INDEX frame_set_frames_set_idx ON frame_set_frames(frame_set_id, dataset_source_id, ordinal);
