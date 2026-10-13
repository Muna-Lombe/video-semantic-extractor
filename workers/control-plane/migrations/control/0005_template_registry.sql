-- Freeze policy definitions and deduplicate templates by their governed inputs.
ALTER TABLE policy_versions ADD COLUMN sha256 TEXT;
CREATE UNIQUE INDEX templates_inputs_idx
  ON templates(frame_set_id, policy_version_id, schema_version);
CREATE INDEX policy_versions_created_idx ON policy_versions(created_at, id);
CREATE INDEX templates_created_idx ON templates(created_at, id);
