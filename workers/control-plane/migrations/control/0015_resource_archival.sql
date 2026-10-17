-- Compact history survives payload reclamation. Existing artifact identity stays immutable.
CREATE TABLE resource_archives (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('frame_set','model_version')),
  resource_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('scheduled','deleting','deleted','cancelled')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
);
CREATE UNIQUE INDEX one_resource_archive ON resource_archives(resource_type,resource_id) WHERE state != 'cancelled';
CREATE TABLE artifact_retirements (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
  archive_id TEXT NOT NULL REFERENCES resource_archives(id),
  etag TEXT,
  deleted_at TEXT
);
CREATE TABLE retention_pins (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('frame_set','model_version')),
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);
CREATE TABLE retention_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stale_days INTEGER NOT NULL DEFAULT 30 CHECK (stale_days BETWEEN 7 AND 365),
  grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 1 AND 90)
);
INSERT INTO retention_settings(id) VALUES (1);
CREATE TRIGGER immutable_archive_snapshot BEFORE UPDATE OF resource_type,resource_id,snapshot_json,snapshot_sha256,storage_key,reason,created_at,delete_after ON resource_archives
BEGIN SELECT RAISE(ABORT,'immutable_archive_snapshot'); END;
CREATE TRIGGER no_pin_retiring_resource BEFORE INSERT ON retention_pins
WHEN EXISTS (SELECT 1 FROM resource_archives WHERE resource_type=NEW.resource_type AND resource_id=NEW.resource_id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_template_on_retiring_frames BEFORE INSERT ON templates
WHEN EXISTS (SELECT 1 FROM resource_archives WHERE resource_type='frame_set' AND resource_id=NEW.frame_set_id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_campaign_on_retiring_frames BEFORE INSERT ON review_campaigns
WHEN EXISTS (SELECT 1 FROM templates t JOIN resource_archives a ON a.resource_type='frame_set' AND a.resource_id=t.frame_set_id AND a.state!='cancelled' WHERE t.id=NEW.template_id)
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_evaluation_on_retiring_inputs BEFORE INSERT ON evaluation_runs
WHEN EXISTS (SELECT 1 FROM resource_archives a WHERE a.state!='cancelled' AND
 ((a.resource_type='model_version' AND a.resource_id=NEW.model_version_id) OR
 (a.resource_type='frame_set' AND a.resource_id IN (SELECT t.frame_set_id FROM ground_truth_versions g JOIN review_campaigns c ON c.id=g.campaign_id JOIN templates t ON t.id=c.template_id WHERE g.id=NEW.ground_truth_version_id))))
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_reactivate_retiring_frames BEFORE UPDATE OF status ON frame_sets
WHEN NEW.status='ready' AND EXISTS (SELECT 1 FROM resource_archives WHERE resource_type='frame_set' AND resource_id=NEW.id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_reactivate_retiring_model BEFORE UPDATE OF status ON model_versions
WHEN NEW.status NOT IN ('rejected','retired') AND EXISTS (SELECT 1 FROM resource_archives WHERE resource_type='model_version' AND resource_id=NEW.id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TABLE retention_orphan_cursor (id INTEGER PRIMARY KEY CHECK(id=1),cursor TEXT);
INSERT INTO retention_orphan_cursor(id) VALUES (1);
CREATE TRIGGER no_attach_retiring_payload BEFORE INSERT ON frame_set_frames
WHEN EXISTS (SELECT 1 FROM artifact_retirements WHERE artifact_id=NEW.artifact_id)
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_retry_retiring_evaluation BEFORE UPDATE OF status ON internal_jobs
WHEN NEW.status IN ('queued','running') AND EXISTS (
 SELECT 1 FROM evaluation_runs e JOIN resource_archives a ON a.state!='cancelled' AND
 ((a.resource_type='model_version' AND a.resource_id=e.model_version_id) OR
 (a.resource_type='frame_set' AND a.resource_id IN (SELECT t.frame_set_id FROM ground_truth_versions g JOIN review_campaigns c ON c.id=g.campaign_id JOIN templates t ON t.id=c.template_id WHERE g.id=e.ground_truth_version_id))) WHERE e.job_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
ALTER TABLE resource_archives ADD COLUMN purge_lease_token TEXT;
ALTER TABLE resource_archives ADD COLUMN purge_lease_until TEXT;
CREATE TRIGGER retain_archive_record BEFORE DELETE ON resource_archives
BEGIN SELECT RAISE(ABORT,'retain_archive_record'); END;
CREATE TRIGGER no_template_relink_to_retiring_frames BEFORE UPDATE OF frame_set_id ON templates
WHEN EXISTS (SELECT 1 FROM resource_archives WHERE resource_type='frame_set' AND resource_id=NEW.frame_set_id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_campaign_relink_to_retiring_frames BEFORE UPDATE OF template_id ON review_campaigns
WHEN EXISTS (SELECT 1 FROM templates t JOIN resource_archives a ON a.resource_type='frame_set' AND a.resource_id=t.frame_set_id AND a.state!='cancelled' WHERE t.id=NEW.template_id)
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_frame_relink_to_retiring_payload BEFORE UPDATE OF artifact_id,frame_set_id ON frame_set_frames
WHEN EXISTS (SELECT 1 FROM artifact_retirements WHERE artifact_id=NEW.artifact_id)
 OR EXISTS (SELECT 1 FROM resource_archives WHERE resource_type='frame_set' AND resource_id=NEW.frame_set_id AND state!='cancelled')
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_evaluation_relink_to_retiring_inputs BEFORE UPDATE OF ground_truth_version_id,model_version_id ON evaluation_runs
WHEN EXISTS (SELECT 1 FROM resource_archives a WHERE a.state!='cancelled' AND
 ((a.resource_type='model_version' AND a.resource_id=NEW.model_version_id) OR
 (a.resource_type='frame_set' AND a.resource_id IN (SELECT t.frame_set_id FROM ground_truth_versions g JOIN review_campaigns c ON c.id=g.campaign_id JOIN templates t ON t.id=c.template_id WHERE g.id=NEW.ground_truth_version_id))))
BEGIN SELECT RAISE(ABORT,'resource_archiving'); END;
CREATE TRIGGER no_register_deleted_archive BEFORE INSERT ON resource_archives
WHEN EXISTS (SELECT 1 FROM artifact_tombstones WHERE storage_key=NEW.storage_key)
BEGIN SELECT RAISE(ABORT,'artifact_tombstoned'); END;
