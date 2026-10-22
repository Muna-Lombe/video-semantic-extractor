/** @type test @purpose Keep draft preflight informative, read-only and distinct from validation or review completion. */
import { describe, expect, it } from "vitest";
import { fixture, campaign, call, ready } from "./campaign-test-support";
import { previewGroundTruthContent, validateGroundTruthContent } from "./ground-truth-validation";

describe("saved review preflight", () => {
  it("reports policy blockers before reviews without initializing an adjudication", async () => {
    const { env, template } = await fixture();
    const created = await campaign(env, template);
    const path = `/api/internal/v1/review-campaigns/${created.data.id}/preflight`;
    const response = await call(env, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await response.json();
    expect(data).toMatchObject({ annotations: null, draft_revision: null, eligibility_assessed: false, readiness: { diagnostic_ready: false } });
    expect(data.readiness.blockers.join(" ")).toContain("validation profile");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM campaign_adjudications").get().n).toBe(0);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_versions").get().n).toBe(0);
    expect((await call(env, path, "POST", {})).status).toBe(405);
    expect((await call(env, path, "GET", undefined, null)).status).toBe(401);
    expect((await call(env, path, "GET", undefined, created.invitations["reviewer-a"].api_token)).status).toBe(403);
  });

  it("counts saved draft objects without fabricating completion or changing saved evidence", async () => {
    const { env, template } = await fixture();
    const created = await campaign(env, template);
    const draft = await ready(env, created, "cup", "chair");
    const before = env.CONTROL_DB.db.prepare("SELECT * FROM campaign_adjudications WHERE campaign_id = ?").get(created.data.id);
    const auditBefore = env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events").get().n;
    const { data } = await (await call(env, `/api/internal/v1/review-campaigns/${created.data.id}/preflight`)).json();
    expect(data).toMatchObject({ draft_revision: draft.revision, eligibility_assessed: false, annotations: { counts: { frames: 1, objects: 1, non_person_objects: 1 }, corpus_adequacy_gates: { review_complete: false } } });
    expect(data.failed_gates).toContain("subset_minimums");
    expect(data.failed_gates).toContain("review_complete");
    expect(env.CONTROL_DB.db.prepare("SELECT * FROM campaign_adjudications WHERE campaign_id = ?").get(created.data.id)).toEqual(before);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events").get().n).toBe(auditBefore);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_validations").get().n).toBe(0);
    expect(env.CONTROL_DB.db.prepare("SELECT status FROM review_campaigns WHERE id = ?").get(created.data.id).status).toBe("awaiting_adjudication");
    expect(validateGroundTruthContent(draft.merged, draft.merged).errors.join(" ")).toContain("completed independent passes");
  });

  it("still rejects malformed or incomplete frame annotations in a preview", async () => {
    const { env, template } = await fixture();
    const created = await campaign(env, template);
    const draft = await ready(env, created);
    const damaged = structuredClone(draft.merged);
    damaged.sources[0].frames[0].objects[0].region = [-1, 0, 20, 30];
    const report = previewGroundTruthContent(draft.merged, damaged);
    expect(report.valid).toBe(false);
    expect(report.counts.objects).toBe(0);
    expect(report.errors.join(" ")).toContain("within the frame");
  });
});
