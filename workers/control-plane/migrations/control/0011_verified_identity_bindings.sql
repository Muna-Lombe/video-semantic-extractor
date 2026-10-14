ALTER TABLE campaign_assignments ADD COLUMN assignee_user_id TEXT REFERENCES internal_users(id);
CREATE INDEX campaign_assignments_assignee_idx ON campaign_assignments(assignee_user_id);

ALTER TABLE ground_truth_decisions ADD COLUMN actor_user_id TEXT REFERENCES internal_users(id);
