-- Managed campaigns preserve the legacy invitation UI while keeping mutable
-- assignments and submissions transactional and isolated from one another.
ALTER TABLE review_campaigns ADD COLUMN template_sha256 TEXT;
ALTER TABLE review_campaigns ADD COLUMN idempotency_key TEXT;
ALTER TABLE review_campaigns ADD COLUMN invitation_hours INTEGER NOT NULL DEFAULT 168;
CREATE UNIQUE INDEX review_campaigns_request_idx
  ON review_campaigns(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX review_campaigns_created_idx ON review_campaigns(created_at, id);

CREATE TABLE campaign_assignments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES review_campaigns(id),
  role TEXT NOT NULL CHECK (role IN ('reviewer-a', 'reviewer-b', 'adjudicator')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  submission_json TEXT CHECK (submission_json IS NULL OR length(CAST(submission_json AS BLOB)) <= 524288),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  revoked_at TEXT,
  UNIQUE (campaign_id, role)
);

CREATE TABLE campaign_adjudications (
  campaign_id TEXT PRIMARY KEY REFERENCES review_campaigns(id),
  comparison_json TEXT NOT NULL,
  merged_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
