ALTER TABLE internal_users ADD COLUMN email_verified_at TEXT;

CREATE TABLE internal_auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'sign_in')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_session_id TEXT
);
CREATE INDEX internal_auth_challenges_user_idx ON internal_auth_challenges(user_id, purpose, created_at);
CREATE INDEX internal_auth_challenges_expiry_idx ON internal_auth_challenges(expires_at);

CREATE TABLE internal_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES internal_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX internal_sessions_user_idx ON internal_sessions(user_id, expires_at);
CREATE INDEX internal_sessions_expiry_idx ON internal_sessions(expires_at);