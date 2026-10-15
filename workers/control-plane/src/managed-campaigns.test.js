/** @type test @purpose Verify isolated campaigns, revocation races, and immutable candidates. */
import { describe, expect, it } from "vitest";
import { fixture, campaign, call, callWithHeaders, state, save, ready, finishReview, reviewerPath, adjudicatorPath } from "./campaign-test-support";
import { environment, policy, frameSet, templateInput, policyInput, call as registryCall } from "./registry-test-support";
const clone = (value) => JSON.parse(JSON.stringify(value));
const adminBase = "/api/internal/v1/review-campaigns";
async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function annotated(state, label = "person", reviewed = true) {
  const value = clone(state.annotations), source = value.sources[0], frame = source.frames[0];
  frame.objects = label ? [{ id: `${label}-1`, label, subset: "live", region: [1, 2, 20, 30] }] : [];
  value.review.reviewed_frames = reviewed ? [`${source.source}/${frame.filename}`] : [];
  return value;
}

describe("managed review campaigns", () => {
  it("pins configurable annotation restrictions and rejects out-of-policy labels without saving", async () => {
    const env = environment(); await frameSet(env);
    const registered = await policy(env, { ...policyInput, annotation_rules: { allowed_labels: ["chair"], allowed_subsets: ["screen"], max_objects_per_frame: 1 } });
    const template = (await (await registryCall(env, "/templates", "POST", templateInput(registered.id))).json()).data;
    const created = await campaign(env, template), invitation = created.invitations["reviewer-a"];
    const initial = await state(env, invitation), value = clone(initial.annotations);
    value.sources[0].frames[0].objects = [{ id: "obj_1", label: "person", subset: "screen", region: [1,1,10,10] }];
    expect((await save(env, invitation, value)).status).toBe(400);
    value.sources[0].frames[0].objects[0].label = "chair";
    expect((await save(env, invitation, value)).status).toBe(200);
    expect((await state(env, invitation)).annotations.validation.annotation_rules).toEqual({ allowed_labels: ["chair"], allowed_subsets: ["screen"], max_objects_per_frame: 1 });
  });
  it("creates three scoped invitations from a registered template without exposing secrets in progress or audit views", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template);
    expect(created.data).toMatchObject({ template_id: template.id, template_sha256: template.sha256, status: "ready", frame_count: 1 });
    const invitations = Object.values(created.invitations);
    expect(new Set(invitations.map((value) => value.api_token)).size).toBe(3);
    const listing = await call(env, adminBase), text = await listing.text();
    expect(text).toContain(created.data.id);
    for (const invitation of invitations) expect(text).not.toContain(invitation.api_token);
    expect(text).not.toContain("token_hash"); expect(text).not.toContain("submission_json");
    const detail = await (await call(env, `${adminBase}/${created.data.id}`)).json();
    expect(detail.data.audit_events[0].action).toBe("campaign.create");
    const reviewer = created.invitations["reviewer-a"];
    const me = await (await call(env, "/api/v1/me", "GET", undefined, reviewer.api_token)).json();
    expect(me).toMatchObject({ actor: { role: "reviewer-a" }, campaign_id: created.data.id, links: { state: reviewerPath(reviewer) } });
    const initial = await state(env, reviewer);
    expect(initial.annotations.provenance.policy_version_id).toBe(template.policy_version_id);
    expect(initial.policy.document).toContain("Two independent human passes");
    expect(initial).not.toHaveProperty("reviewer_b");
    expect((await call(env, `${reviewerPath(reviewer)}/policy`, "GET", undefined, reviewer.api_token)).status).toBe(200);
    const evidence = await call(env, `${reviewerPath(reviewer)}/frames/src_test/frame_test.jpg`, "GET", undefined, reviewer.api_token);
    expect(evidence.status).toBe(200); expect(evidence.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await evidence.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("issues job tokens on demand from an assignment and invalidates each rotated token", async () => {
    const { env, template } = await fixture();
    const createdResponse = await call(env, adminBase, "POST", { name: "On-demand tokens", template_id: template.id, issue_tokens: false });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created).not.toHaveProperty("invitations");
    expect(created.data.assignments.every((assignment) => assignment.job_token_issued_at === null)).toBe(true);

    const role = "reviewer-a";
    const action = `${adminBase}/${created.data.id}/assignments/${role}/issue`;
    const issuedResponse = await call(env, action, "POST");
    expect(issuedResponse.status).toBe(200);
    const issued = await issuedResponse.json();
    expect(issued.invitation).toMatchObject({ assignment_id: expect.any(String), job_token: expect.any(String) });
    expect(issued.assignment.job_token_issued_at).toEqual(expect.any(String));
    expect((await call(env, reviewerPath(issued.invitation), "GET", undefined, issued.invitation.job_token)).status).toBe(200);
    expect((await call(env, reviewerPath(issued.invitation), "GET", undefined, "unissued-token")).status).toBe(401);

    const rotatedResponse = await call(env, action, "POST");
    const rotated = await rotatedResponse.json();
    expect(rotated.invitation.job_token).not.toBe(issued.invitation.job_token);
    expect((await call(env, reviewerPath(issued.invitation), "GET", undefined, issued.invitation.job_token)).status).toBe(401);
    expect((await call(env, reviewerPath(rotated.invitation), "GET", undefined, rotated.invitation.job_token)).status).toBe(200);

    const revoked = await call(env, `${adminBase}/${created.data.id}/assignments/${role}/revoke`, "POST");
    expect(revoked.status).toBe(200);
    expect((await call(env, reviewerPath(rotated.invitation), "GET", undefined, rotated.invitation.job_token)).status).toBe(401);
    expect(await (await call(env, `${adminBase}/${created.data.id}`)).text()).not.toContain(rotated.invitation.job_token);
  });

  it("binds managed assignments to a verified role and requires both the user session and job token", async () => {
    const { env, template } = await fixture();
    const createdResponse = await call(env, adminBase, "POST", { name: "Identity-bound review", template_id: template.id, issue_tokens: false });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    const userId = `user_${"a".repeat(32)}`;
    const timestamp = new Date().toISOString();
    env.CONTROL_DB.db.prepare("INSERT INTO internal_users (id, email, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .run(userId, "reviewer@example.test", "Verified Reviewer", timestamp, timestamp, timestamp);
    env.CONTROL_DB.db.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, 'reviewer', ?)")
      .run(userId, timestamp);
    const session = "verified-reviewer-session";
    env.CONTROL_DB.db.prepare("INSERT INTO internal_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session_reviewer_test", userId, await hash(session), timestamp, new Date(Date.now() + 60_000).toISOString(), timestamp);

    const assignPath = `${adminBase}/${created.data.id}/assignments/reviewer-a/assign`;
    const bound = await call(env, assignPath, "POST", { user_id: userId });
    expect(bound.status).toBe(200);
    expect((await bound.json()).assignment).toMatchObject({ assignee_user_id: userId, assignee_email: "reviewer@example.test" });
    const issued = await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/issue`, "POST");
    expect(issued.status).toBe(200);
    const invitation = (await issued.json()).invitation;
    const path = reviewerPath(invitation);

    expect((await call(env, "/api/v1/me", "GET", undefined, invitation.job_token)).status).toBe(401);
    const signedIn = await callWithHeaders(env, "/api/v1/me", "GET", undefined, {
      authorization: `Bearer ${invitation.job_token}`,
      cookie: `internals_session=${session}`,
    });
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).actor.role).toBe("reviewer-a");

    const stateWithSession = await callWithHeaders(env, path, "GET", undefined, {
      authorization: `Bearer ${invitation.job_token}`,
      cookie: `internals_session=${session}`,
    });
    expect(stateWithSession.status).toBe(200);
    const wrongSession = "other-verified-session";
    const wrongUserId = `user_${"b".repeat(32)}`;
    env.CONTROL_DB.db.prepare("INSERT INTO internal_users (id, email, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .run(wrongUserId, "other@example.test", "Other Reviewer", timestamp, timestamp, timestamp);
    env.CONTROL_DB.db.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, 'reviewer', ?)")
      .run(wrongUserId, timestamp);
    env.CONTROL_DB.db.prepare("INSERT INTO internal_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session_other_test", wrongUserId, await hash(wrongSession), timestamp, new Date(Date.now() + 60_000).toISOString(), timestamp);
    const denied = await callWithHeaders(env, path, "GET", undefined, {
      authorization: `Bearer ${invitation.job_token}`,
      cookie: `internals_session=${wrongSession}`,
    });
    expect(denied.status).toBe(403);
  });

  it("deduplicates campaign creation and allows recovery by reissuing lost invitations", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template, "Recovery", "request-1");
    const duplicate = await call(env, adminBase, "POST", { name: "Recovery", template_id: template.id, idempotency_key: "request-1" });
    expect(duplicate.status).toBe(200);
    const payload = await duplicate.json(); expect(payload.data.id).toBe(created.data.id); expect(payload).not.toHaveProperty("invitations");
    expect((await call(env, adminBase, "POST", { name: "Different", template_id: template.id, idempotency_key: "request-1" })).status).toBe(409);
    const response = await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/reissue`, "POST");
    expect(response.status).toBe(200);
    const replacement = (await response.json()).invitation;
    expect((await call(env, reviewerPath(created.invitations["reviewer-a"]), "GET", undefined, created.invitations["reviewer-a"].api_token)).status).toBe(401);
    expect((await state(env, replacement)).revision).toBe(1);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM review_campaigns").get().n).toBe(1);
  });

  it("isolates assignments, campaigns, coordinator routes, policy access, and adjudication evidence", async () => {
    const { env, template } = await fixture(), first = await campaign(env, template), second = await campaign(env, template, "Other campaign");
    const a = first.invitations["reviewer-a"], b = first.invitations["reviewer-b"], c = first.invitations.adjudicator;
    expect((await call(env, reviewerPath(b), "GET", undefined, a.api_token)).status).toBe(403);
    expect((await call(env, `${reviewerPath(b)}/policy`, "GET", undefined, a.api_token)).status).toBe(403);
    expect((await call(env, `${reviewerPath(second.invitations["reviewer-a"])}/frames/src_test/frame_test.jpg`, "GET", undefined, a.api_token)).status).toBe(403);
    expect((await call(env, adminBase, "GET", undefined, a.api_token)).status).toBe(403);
    expect((await call(env, adjudicatorPath(c), "GET", undefined, a.api_token)).status).toBe(403);
    expect((await call(env, adjudicatorPath(c), "GET", undefined, c.api_token)).status).toBe(409);
    expect((await call(env, `${reviewerPath(c)}/frames/src_test/frame_test.jpg`, "GET", undefined, c.api_token)).status).toBe(409);
    expect((await call(env, `${reviewerPath(c)}/policy`, "GET", undefined, c.api_token)).status).toBe(200);
    expect((await call(env, reviewerPath(a), "GET")).status).toBe(401);
    expect((await call(env, reviewerPath(a), "GET", undefined, null)).status).toBe(401);
    await finishReview(env, b, "chair");
    const blind = await state(env, a);
    expect(JSON.stringify(blind)).not.toContain('"label":"chair"');
    expect(blind.annotations.sources[0].frames[0].objects).toEqual([]);
  });

  it("handles simultaneous independent saves and completions without losing either submission", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template);
    const adjudication = await ready(env, created);
    expect(adjudication.reviewer_a.sources[0].frames[0].objects[0].label).toBe("person");
    expect(adjudication.reviewer_b.sources[0].frames[0].objects[0].label).toBe("chair");
    expect(adjudication.comparison.agree).toBe(false);
    const detail = (await (await call(env, `${adminBase}/${created.data.id}`)).json()).data;
    expect(detail.status).toBe("awaiting_adjudication");
    expect(detail.assignments.filter((assignment) => assignment.role !== "adjudicator").every((assignment) => assignment.reviewed_frames === 1 && assignment.status === "complete")).toBe(true);
  });

  it("requires a revision and rejects stale or concurrent edits to the same assignment", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"], initial = await state(env, reviewer), value = annotated(initial);
    expect((await call(env, reviewerPath(reviewer), "PUT", value, reviewer.api_token)).status).toBe(428);
    const results = await Promise.all([save(env, reviewer, value), save(env, reviewer, value)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await call(env, `${reviewerPath(reviewer)}/complete`, "POST", {}, reviewer.api_token, 0)).status).toBe(412);
    expect((await state(env, reviewer)).revision).toBe(1);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action = 'review.save'").get().n).toBe(1);
  });

  it.each([
    ["changed provenance", (value) => { value.provenance.policy_sha256 = "x"; }],
    ["changed frame ID", (value) => { value.sources[0].frames[0].frame_id = "frame_other"; }],
    ["changed timestamp", (value) => { value.sources[0].frames[0].timestamp_sec = 1; }],
    ["changed source checksum", (value) => { value.sources[0].source_sha256 = "x"; }],
    ["unknown frame metadata", (value) => { value.sources[0].frames[0].url = "https://other.test/"; }],
    ["non-COCO class", (value) => { value.sources[0].frames[0].objects[0].label = "microphone"; }],
    ["unknown subset", (value) => { value.sources[0].frames[0].objects[0].subset = "other"; }],
    ["out-of-bounds box", (value) => { value.sources[0].frames[0].objects[0].region = [300, 0, 30, 10]; }],
    ["zero-width box", (value) => { value.sources[0].frames[0].objects[0].region = [0, 0, 0, 10]; }],
    ["duplicate annotation IDs", (value) => { value.sources[0].frames[0].objects.push(clone(value.sources[0].frames[0].objects[0])); }],
    ["oversized frame annotation lists", (value) => { value.sources[0].frames[0].objects = Array.from({ length: 201 }, (_, index) => ({ ...value.sources[0].frames[0].objects[0], id: `object-${index}` })); }],
    ["duplicate frame coverage", (value) => { value.review.reviewed_frames.push(value.review.reviewed_frames[0]); }],
    ["seen predictions", (value) => { value.review.predictions_reviewed_before_freeze = true; }],
  ])("rejects %s without saving or auditing an edit", async (_label, edit) => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"], value = annotated(await state(env, reviewer));
    edit(value);
    expect((await save(env, reviewer, value)).status).toBe(400);
    expect((await state(env, reviewer)).revision).toBe(0);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action = 'review.save'").get().n).toBe(0);
  });

  it("does not accept claimed human passes or completion without exhaustive frame coverage", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"], value = annotated(await state(env, reviewer), "person", false);
    value.review.independent_passes = 2; value.review.adjudication_status = "complete";
    expect((await save(env, reviewer, value)).status).toBe(200);
    const saved = await state(env, reviewer);
    expect(saved.annotations.review).toMatchObject({ independent_passes: 0, adjudication_status: "not_started" });
    expect((await call(env, `${reviewerPath(reviewer)}/complete`, "POST", {}, reviewer.api_token, saved.revision)).status).toBe(400);
  });

  it("completes adjudication into an immutable candidate with role-scoped result access", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), invitation = created.invitations.adjudicator;
    const initial = await ready(env, created);
    expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision)).status).toBe(400);
    const frame = Object.fromEntries(Object.entries(initial.reviewer_a.sources[0].frames[0]).reverse());
    const resolve = await call(env, `${adjudicatorPath(invitation)}/frames/src_test/frame_test.jpg`, "PUT", { frame, resolution: "reviewer_a" }, invitation.api_token, initial.revision);
    expect(resolve.status).toBe(200);
    const adjudication = await state(env, invitation);
    expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, adjudication.revision)).status).toBe(200);
    const resultPath = `/api/v1/campaigns/${created.data.id}/result`;
    const result = await call(env, resultPath, "GET", undefined, invitation.api_token);
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    const merged = await result.json();
    expect(merged.review).toMatchObject({ independent_passes: 2, adjudication_status: "complete" });
    expect(merged.provenance.policy_version_id).toBe(template.policy_version_id);
    expect(env.CONTROL_DB.db.prepare("SELECT status FROM ground_truth_versions").get().status).toBe("candidate");
    expect((await call(env, resultPath)).status).toBe(200);
    expect((await call(env, resultPath, "GET", undefined, created.invitations["reviewer-a"].api_token)).status).toBe(403);
    const another = await campaign(env, template, "Another");
    expect((await call(env, resultPath, "GET", undefined, another.invitations.adjudicator.api_token)).status).toBe(403);
    expect((await call(env, `${adjudicatorPath(invitation)}/frames/src_test/frame_test.jpg`, "PUT", { frame, resolution: "edited" }, invitation.api_token, adjudication.revision)).status).toBe(409);
    expect((await call(env, `${adminBase}/${created.data.id}/cancel`, "POST")).status).toBe(409);
  });

  it("completes agreement with no artificial disagreement-resolution requirement", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), invitation = created.invitations.adjudicator;
    const initial = await ready(env, created, null, null);
    expect(initial.comparison.disagreements).toEqual([]);
    expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision)).status).toBe(200);
  });

  it("deduplicates simultaneous finalization without overwriting the candidate artifact", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), invitation = created.invitations.adjudicator;
    const initial = await ready(env, created, null, null);
    const responses = await Promise.all([call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision), call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_versions").get().n).toBe(1);
    expect([...env.INTERNAL_ARTIFACTS_BUCKET.objects.keys()].filter((key) => key.includes('/results/'))).toHaveLength(1);
    expect((await call(env, `/api/v1/campaigns/${created.data.id}/result`)).status).toBe(200);
  });

  it("revokes and reissues invitations while preserving the saved submission", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"];
    await save(env, reviewer, annotated(await state(env, reviewer)));
    expect((await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/revoke`, "POST")).status).toBe(200);
    expect((await call(env, reviewerPath(reviewer), "GET", undefined, reviewer.api_token)).status).toBe(401);
    const replaced = (await (await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/reissue`, "POST")).json()).invitation;
    const current = await state(env, replaced);
    expect(current.annotations.sources[0].frames[0].objects[0].label).toBe("person");
    expect(current.revision).toBe(3);
    env.CONTROL_DB.db.exec("UPDATE campaign_assignments SET expires_at = '2000-01-01T00:00:00Z'");
    expect((await call(env, reviewerPath(replaced), "GET", undefined, replaced.api_token)).status).toBe(401);
  });

  it("rejects a save revoked after authentication but before the D1 write", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"], value = annotated(await state(env, reviewer));
    const originalGet = env.INTERNAL_ARTIFACTS_BUCKET.get.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    let revoked = false;
    env.INTERNAL_ARTIFACTS_BUCKET.get = async (key) => {
      if (key.startsWith("templates/") && !revoked) { revoked = true; await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/revoke`, "POST"); }
      return originalGet(key);
    };
    expect((await save(env, reviewer, value)).status).toBe(412);
    expect(env.CONTROL_DB.db.prepare("SELECT submission_json FROM campaign_assignments WHERE role = 'reviewer-a'").get().submission_json).toBeNull();
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action = 'review.save'").get().n).toBe(0);
  });

  it("rolls back failed finalization and rejects revocation during artifact upload", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), invitation = created.invitations.adjudicator;
    const initial = await ready(env, created, null, null);
    env.CONTROL_DB.db.exec("CREATE TRIGGER reject_truth BEFORE INSERT ON ground_truth_versions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision)).status).toBe(500);
    expect(env.CONTROL_DB.db.prepare("SELECT status FROM review_campaigns").get().status).toBe("awaiting_adjudication");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'ground_truth'").get().n).toBe(0);
    expect([...env.INTERNAL_ARTIFACTS_BUCKET.objects.keys()].filter((key) => key.includes('/results/'))).toHaveLength(0);
    env.CONTROL_DB.db.exec("DROP TRIGGER reject_truth");
    const originalPut = env.INTERNAL_ARTIFACTS_BUCKET.put.bind(env.INTERNAL_ARTIFACTS_BUCKET);
    env.INTERNAL_ARTIFACTS_BUCKET.put = async (key, ...args) => {
      await originalPut(key, ...args);
      if (key.includes('/results/')) await call(env, `${adminBase}/${created.data.id}/assignments/adjudicator/revoke`, "POST");
    };
    expect((await call(env, `${adjudicatorPath(invitation)}/complete`, "POST", {}, invitation.api_token, initial.revision)).status).toBe(412);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_versions").get().n).toBe(0);
  });

  it("cancels a campaign and invalidates all three tokens", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template);
    expect((await call(env, `${adminBase}/${created.data.id}/cancel`, "POST")).status).toBe(200);
    for (const invitation of Object.values(created.invitations)) expect((await call(env, `${reviewerPath(invitation)}/policy`, "GET", undefined, invitation.api_token)).status).toBe(401);
    expect((await call(env, `${adminBase}/${created.data.id}/assignments/reviewer-a/reissue`, "POST")).status).toBe(409);
  });

  it("rejects missing, corrupted, or unready campaign inputs and embedded artifacts", async () => {
    const { env, template } = await fixture();
    expect((await call(env, adminBase, "POST", { name: "Invalid", template_id: template.id, frame_urls: {} })).status).toBe(400);
    env.CONTROL_DB.db.exec("UPDATE templates SET status = 'archived'");
    expect((await call(env, adminBase, "POST", { name: "Archived", template_id: template.id })).status).toBe(409);
    env.CONTROL_DB.db.exec("UPDATE templates SET status = 'ready'; UPDATE policy_versions SET status = 'retired'");
    expect((await call(env, adminBase, "POST", { name: "Retired", template_id: template.id })).status).toBe(409);
    env.CONTROL_DB.db.exec("UPDATE policy_versions SET status = 'active'");
    const artifact = env.CONTROL_DB.db.prepare("SELECT storage_key FROM artifacts WHERE kind = 'template'").get();
    env.INTERNAL_ARTIFACTS_BUCKET.objects.get(artifact.storage_key).bytes[0] = 120;
    expect((await call(env, adminBase, "POST", { name: "Corrupt", template_id: template.id })).status).toBe(422);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM campaign_assignments").get().n).toBe(0);
  });

  it("verifies private evidence bytes and refuses unregistered frame paths", async () => {
    const { env, template } = await fixture(), created = await campaign(env, template), reviewer = created.invitations["reviewer-a"];
    expect((await call(env, `${reviewerPath(reviewer)}/frames/%ZZ/frame_test.jpg`, "GET", undefined, reviewer.api_token)).status).toBe(400);
    expect((await call(env, `${reviewerPath(reviewer)}/frames/src_test/other.jpg`, "GET", undefined, reviewer.api_token)).status).toBe(404);
    env.INTERNAL_ARTIFACTS_BUCKET.objects.get('frame.jpg').bytes[0] = 4;
    expect((await call(env, `${reviewerPath(reviewer)}/frames/src_test/frame_test.jpg`, "GET", undefined, reviewer.api_token)).status).toBe(422);
    env.INTERNAL_ARTIFACTS_BUCKET.objects.delete('frame.jpg');
    expect((await call(env, `${reviewerPath(reviewer)}/frames/src_test/frame_test.jpg`, "GET", undefined, reviewer.api_token)).status).toBe(503);
  });
});
