-- Immutable model/release inputs; lifecycle decisions are append-only audit records.
ALTER TABLE model_versions ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE model_versions ADD COLUMN license TEXT NOT NULL DEFAULT '';
ALTER TABLE model_versions ADD COLUMN evaluation_run_id TEXT REFERENCES evaluation_runs(id);
ALTER TABLE model_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_releases ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected'));
ALTER TABLE pipeline_releases ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
-- CHECK failures roll back the entire D1 batch, including decisions and audit rows.
CREATE TABLE governance_assertions (valid INTEGER NOT NULL CHECK (valid = 1));
CREATE TRIGGER clear_governance_assertions AFTER INSERT ON governance_assertions
BEGIN DELETE FROM governance_assertions; END;
CREATE UNIQUE INDEX one_active_pipeline_release ON pipeline_releases(status) WHERE status = 'active';
CREATE TRIGGER immutable_model_inputs BEFORE UPDATE OF model_id, version, artifact_id, configuration_json, provenance_json, license ON model_versions
BEGIN SELECT RAISE(ABORT, 'immutable_model_inputs'); END;
CREATE TRIGGER immutable_release_inputs BEFORE UPDATE OF version, configuration_json ON pipeline_releases
BEGIN SELECT RAISE(ABORT, 'immutable_release_inputs'); END;
CREATE TRIGGER immutable_artifact_identity BEFORE UPDATE OF storage_key, sha256, size_bytes, media_type ON artifacts
BEGIN SELECT RAISE(ABORT, 'immutable_artifact_identity'); END;
CREATE TRIGGER append_only_audit_update BEFORE UPDATE ON internal_audit_events
BEGIN SELECT RAISE(ABORT, 'append_only_audit'); END;
CREATE TRIGGER append_only_audit_delete BEFORE DELETE ON internal_audit_events
BEGIN SELECT RAISE(ABORT, 'append_only_audit'); END;
