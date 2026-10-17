-- Persist selection provenance with the immutable dataset version.
ALTER TABLE dataset_versions ADD COLUMN selection_json TEXT;
ALTER TABLE dataset_sources ADD COLUMN expected_sha256 TEXT;
CREATE TRIGGER immutable_sample_selection BEFORE UPDATE OF selection_json ON dataset_versions
WHEN OLD.selection_json IS NOT NULL AND NEW.selection_json IS NOT OLD.selection_json
BEGIN SELECT RAISE(ABORT,'immutable_sample_selection'); END;
CREATE TRIGGER immutable_expected_source_digest BEFORE UPDATE OF expected_sha256 ON dataset_sources
WHEN OLD.expected_sha256 IS NOT NULL AND NEW.expected_sha256 IS NOT OLD.expected_sha256
BEGIN SELECT RAISE(ABORT,'immutable_expected_source_digest'); END;
