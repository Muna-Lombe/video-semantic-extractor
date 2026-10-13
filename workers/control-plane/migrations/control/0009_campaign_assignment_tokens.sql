ALTER TABLE campaign_assignments RENAME TO campaign_assignments_previous;

CREATE TABLE campaign_assignments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES review_campaigns(id),
  role TEXT NOT NULL CHECK (role IN ('reviewer-a', 'reviewer-b', 'adjudicator')),
  token_hash TEXT UNIQUE,
  token_issued_at TEXT,
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

INSERT INTO campaign_assignments (
  id, campaign_id, role, token_hash, token_issued_at, status, submission_json,
  revision, last_operation_id, created_at, updated_at, expires_at, completed_at, revoked_at
)
SELECT
  id, campaign_id, role, token_hash,
  CASE WHEN token_hash IS NOT NULL THEN created_at ELSE NULL END,
  status, submission_json, revision, last_operation_id, created_at, updated_at,
  expires_at, completed_at, revoked_at
FROM campaign_assignments_previous;

DROP TABLE campaign_assignments_previous;
