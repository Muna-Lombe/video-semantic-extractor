-- Transactional metadata for versioned source datasets. HTTPS source URLs form the
-- immutable input manifest; later ingestion may attach opaque artifact/checksum
-- metadata owned by the control-plane database and object storage.
PRAGMA foreign_keys = ON;

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'active', 'archived')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dataset_versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'frozen', 'archived')),
  manifest_artifact_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (dataset_id, version)
);
CREATE INDEX dataset_versions_dataset_idx ON dataset_versions(dataset_id, version);

CREATE TABLE dataset_sources (
  id TEXT PRIMARY KEY,
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  display_name TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  artifact_id TEXT,
  source_sha256 TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (dataset_version_id, source_url),
  UNIQUE (dataset_version_id, ordinal)
);
CREATE INDEX dataset_sources_version_idx ON dataset_sources(dataset_version_id, ordinal);
