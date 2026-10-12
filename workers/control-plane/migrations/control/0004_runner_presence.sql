-- Record runners that have checked in within the availability window.
CREATE TABLE runner_presence (
  runner_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('available', 'busy')),
  current_job_id TEXT,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX runner_presence_expiry_idx ON runner_presence(expires_at, status);
