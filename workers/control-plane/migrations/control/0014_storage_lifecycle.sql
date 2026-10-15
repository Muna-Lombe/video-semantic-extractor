-- Tombstones serialize cleanup with registration in the same transactional database.
ALTER TABLE policy_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE artifact_tombstones (
  storage_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TRIGGER no_register_deleted_artifact BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM artifact_tombstones WHERE storage_key = NEW.storage_key)
BEGIN SELECT RAISE(ABORT, 'artifact_tombstoned'); END;
CREATE TRIGGER no_upload_deleted_artifact BEFORE INSERT ON artifact_uploads
WHEN EXISTS (SELECT 1 FROM artifact_tombstones WHERE storage_key = NEW.storage_key)
BEGIN SELECT RAISE(ABORT, 'artifact_tombstoned'); END;
CREATE TRIGGER no_register_deleted_validation BEFORE INSERT ON ground_truth_validations
WHEN EXISTS (SELECT 1 FROM artifact_tombstones WHERE storage_key = NEW.report_storage_key)
BEGIN SELECT RAISE(ABORT, 'artifact_tombstoned'); END;
CREATE TRIGGER immutable_policy_definition BEFORE UPDATE OF definition_json, sha256, policy_id, version, instructions_artifact_id ON policy_versions
BEGIN SELECT RAISE(ABORT, 'immutable_policy_definition'); END;
