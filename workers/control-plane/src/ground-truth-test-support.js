/** @type test @purpose Exercise recorded validation, adequacy, approval, rejection, supersession, and eligibility gates. */
import { expect } from "vitest";
import { fixture, campaign, call, state, save, reviewerPath, adjudicatorPath } from "./campaign-test-support";
const base = "/api/internal/v1/ground-truth";
const clone = (value) => JSON.parse(JSON.stringify(value));
const approveBody = { actor_reference: "test-data-custodian", reason: "Checked frozen policy, independent review, and diagnostic licensing scope.", scope: "diagnostic", attestations: { policy_reviewed: true, independent_humans_confirmed: true, predictions_unseen_confirmed: true, licensing_scope_confirmed: true } };
async function candidate(existing, edit) {
  const prepared = existing ?? await fixture({ sourceCount: 5, profile: true }), { env, template } = prepared;
  const created = await campaign(env, template, `Ground truth ${crypto.randomUUID()}`);
  for (const role of ["reviewer-a", "reviewer-b"]) {
    const invitation = created.invitations[role], initial = await state(env, invitation), value = clone(initial.annotations);
    let counter = 0;
    for (const source of value.sources) {
      for (const frame of source.frames) {
        frame.objects = Array.from({ length: 10 }, () => {
          const index = counter++, size = index < 15 ? 100 : index < 30 ? 500 : 200;
          return { id: `object-${index}`, label: ["chair", "cup", "laptop", "bottle", "car"][index % 5], subset: index < 20 ? "live" : index < 40 ? "screen" : "composited", region: [1, 1, size, size] };
        });
      }
    }
    value.review.reviewed_frames = value.sources.flatMap((source) => source.frames.map((frame) => `${source.source}/${frame.filename}`));
    if (edit) edit(value);
    const saved = await save(env, invitation, value, initial.revision);
    expect(saved.status).toBe(200);
    expect((await call(env, `${reviewerPath(invitation)}/complete`, "POST", {}, invitation.api_token, (await saved.json()).revision)).status).toBe(200);
  }
  const invitation = created.invitations.adjudicator, ready = await state(env, invitation);
  expect(ready.comparison.agree).toBe(true);
  expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, ready.revision)).status).toBe(200);
  const truth = env.CONTROL_DB.db.prepare("SELECT * FROM ground_truth_versions WHERE campaign_id = ?").get(created.data.id);
  return { ...prepared, created, truth };
}
async function validate(prepared, revision = 0) {
  return call(prepared.env, `${base}/${prepared.truth.id}/validate`, "POST", {}, "test-admin", revision);
}
async function approved(prepared) {
  const checked = await validate(prepared);
  expect(checked.status).toBe(200);
  const report = await checked.json(); expect(report.validation.passed).toBe(true);
  const decided = await call(prepared.env, `${base}/${prepared.truth.id}/approve`, "POST", approveBody, "test-admin", report.data.revision);
  expect(decided.status).toBe(200);
  return (await decided.json()).data;
}


export { candidate, approved, approveBody };
