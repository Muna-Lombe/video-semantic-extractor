/** @type test @purpose Exercise recorded validation, adequacy, approval, rejection, supersession, and eligibility gates. */
import { describe, expect, it } from "vitest";
import { fixture, campaign, call, callWithHeaders, state, save, reviewerPath, adjudicatorPath } from "./campaign-test-support";
import { getEligibleGroundTruth } from "./ground-truth";
import { sha256Hex } from "./artifact-pipeline";
import { parseValidationProfile, validateGroundTruthContent } from "./ground-truth-validation";
import { call as registryCall, policyInput, templateInput, environment, frameSet, policy } from "./registry-test-support";
const base = "/api/internal/v1/ground-truth";
const clone = (value) => JSON.parse(JSON.stringify(value));
const approveBody = { actor_reference: "test-data-custodian", reason: "Checked frozen policy, independent review, and diagnostic licensing scope.", scope: "diagnostic", attestations: { policy_reviewed: true, independent_humans_confirmed: true, predictions_unseen_confirmed: true, licensing_scope_confirmed: true } };
const rejectBody = { actor_reference: "test-data-custodian", reason: "Candidate must be replaced after review." };
async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

describe("ground-truth validation and diagnostic approval", () => {
  it("records passing validation and approval as separate immutable evidence", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    expect((await getEligibleGroundTruth(env, truth.id)).eligible).toBe(false);
    const response = await validate(prepared); expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toMatchObject({ status: "valid", approval_status: "pending", revision: 1 });
    expect(payload.validation.annotation_validation).toMatchObject({ valid: true, adequate: true, counts: { sources: 5, frames: 5, objects: 50, non_person_objects: 50, non_person_classes: 5 } });
    expect(Object.values(payload.validation.annotation_validation.corpus_adequacy_gates).every(Boolean)).toBe(true);
    expect(payload.validation.provenance.reviewer_submissions).toHaveLength(2);
    expect((await getEligibleGroundTruth(env, truth.id)).eligible).toBe(false);
    const reportPath = `${base}/${truth.id}/validations/${payload.validation.id}/report`, reportResponse = await call(env, reportPath);
    expect(reportResponse.status).toBe(200); expect(reportResponse.headers.get("cache-control")).toBe("no-store");
    const reportText = await reportResponse.text();
    const recorded = env.CONTROL_DB.db.prepare("SELECT * FROM ground_truth_validations").get();
    expect(await sha256Hex(reportText)).toBe(recorded.report_sha256);
    expect(env.CONTROL_DB.db.prepare("SELECT job_type, status FROM internal_jobs WHERE id = ?").get(recorded.job_id)).toMatchObject({ job_type: "validation", status: "succeeded" });
    const approval = await call(env, `${base}/${truth.id}/approve`, "POST", approveBody, "test-admin", 1);
    expect(approval.status).toBe(200);
    const final = (await approval.json()).data;
    expect(final).toMatchObject({ status: "approved", approval_scope: "diagnostic", approval_status: "approved", revision: 2 });
    expect((await getEligibleGroundTruth(env, truth.id)).eligible).toBe(true);
    const detail = (await (await call(env, `${base}/${truth.id}`)).json()).data;
    expect(detail.decisions[0]).toMatchObject({ decision: "approve", actor_reference: approveBody.actor_reference, validation_id: payload.validation.id, attestations: approveBody.attestations });
    expect(env.CONTROL_DB.db.prepare("SELECT approved_by FROM ground_truth_versions").get().approved_by).toBeNull();
    expect((await call(env, `${base}/${truth.id}/eligibility?scope=production`)).status).toBe(400);
    expect((await call(env, `${base}/${truth.id}/artifact`)).status).toBe(200);
  });

  it("authorizes a named release approver and records the authenticated user ID", async () => {
    const prepared = await candidate();
    const validated = await validate(prepared);
    expect(validated.status).toBe(200);
    const { data } = await validated.json();
    const env = prepared.env, timestamp = new Date().toISOString(), userId = `user_${"c".repeat(32)}`;
    const session = "verified-release-approver-session";
    env.CONTROL_DB.db.prepare("INSERT INTO internal_users (id, email, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .run(userId, "approver@example.test", "Release Approver", timestamp, timestamp, timestamp);
    env.CONTROL_DB.db.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, 'release_approver', ?)")
      .run(userId, timestamp);
    env.CONTROL_DB.db.prepare("INSERT INTO internal_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session_approver_test", userId, await hash(session), timestamp, new Date(Date.now() + 60_000).toISOString(), timestamp);
    const response = await callWithHeaders(env, `${base}/${prepared.truth.id}/approve`, "POST", {
      reason: "Verified evidence and approval attestations.",
      scope: "diagnostic",
      attestations: approveBody.attestations,
    }, { origin: "https://internal.test", cookie: `internals_session=${session}`, "if-match": String(data.revision) });
    expect(response.status).toBe(200);
    const decision = env.CONTROL_DB.db.prepare("SELECT actor_user_id, actor_reference FROM ground_truth_decisions WHERE ground_truth_id = ?").get(prepared.truth.id);
    expect(decision).toEqual({ actor_user_id: userId, actor_reference: "approver@example.test" });
  });

  it.each([
    ["insufficient non-person instances", (value) => { value.sources[4].frames[0].objects.pop(); }, "fifty_non_person_instances"],
    ["insufficient class diversity", (value) => { value.sources.forEach((source) => source.frames[0].objects.forEach((object) => { object.label = "chair"; })); }, "five_non_person_classes"],
    ["missing source subsets", (value) => { value.sources.forEach((source) => source.frames[0].objects.forEach((object) => { object.subset = "live"; })); }, "subset_minimums"],
    ["missing small and large boxes", (value) => { value.sources.forEach((source) => source.frames[0].objects.forEach((object) => { object.region = [1, 1, 200, 200]; })); }, "scale_minimums"],
  ])("records %s and refuses approval", async (_label, edit, gate) => {
    const prepared = await candidate(undefined, edit), response = await validate(prepared);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.data.status).toBe("invalid");
    expect(report.validation.annotation_validation).toMatchObject({ valid: true, adequate: false, corpus_adequacy_gates: { [gate]: false } });
    expect((await call(prepared.env, `${base}/${prepared.truth.id}/approve`, "POST", approveBody, "test-admin", 1)).status).toBe(409);
  });

  it.each([["undersized", [1, 1, 7, 8]], ["fractional", [1.5, 1, 100, 100]]])("rejects %s boxes under the frozen diagnostic policy", async (_label, box) => {
    const prepared = await candidate(undefined, (value) => { value.sources[0].frames[0].objects[0].region = box; });
    const report = await (await validate(prepared)).json();
    expect(report.validation.annotation_validation.valid).toBe(false);
    expect(report.validation.annotation_validation.errors.join(" ")).toContain("integer coordinates and at least 8x8 pixels");
  });

  it("binds frozen corpus checksums and cannot infer a missing machine profile from prose", async () => {
    const otherProfile = { id: "coco-object-diagnostic.v1", source_sha256: ["6", "7", "8", "9", "a"].map((character) => character.repeat(64)) };
    const env = environment(); await frameSet(env, 5);
    const registered = await policy(env, { ...policyInput, validation_profile: otherProfile });
    const wrong = await registryCall(env, "/templates", "POST", templateInput(registered.id));
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error.code).toBe("diagnostic_policy_incompatible");
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM templates").get().n).toBe(0);
    const noProfile = await candidate(await fixture({ sourceCount: 5 }));
    const missingReport = await (await validate(noProfile)).json();
    expect(missingReport.validation.passed).toBe(false);
    expect(missingReport.validation.annotation_validation.errors).toContain("a frozen compatible validation profile is required for diagnostic approval");
    const candidateBytes = await (await call(noProfile.env, `${base}/${noProfile.truth.id}/artifact`)).json();
    const legacyCheck = validateGroundTruthContent(candidateBytes, candidateBytes, parseValidationProfile(otherProfile));
    expect(legacyCheck.corpus_adequacy_gates.frozen_five_sources).toBe(false);
  });

  it("rejects arbitrary threshold overrides, duplicate corpus digests, and non-versioned profiles", () => {
    const valid = { id: "coco-object-diagnostic.v1", source_sha256: ["1", "2", "3", "4", "5"].map((character) => character.repeat(64)) };
    expect(parseValidationProfile(valid).id).toBe("coco-object-diagnostic.v1");
    expect(() => parseValidationProfile({ ...valid, minimum_objects: 1 })).toThrow();
    expect(() => parseValidationProfile({ ...valid, source_sha256: Array(5).fill("a".repeat(64)) })).toThrow();
    expect(() => parseValidationProfile({ ...valid, id: "arbitrary" })).toThrow();
  });

  it("keeps failed and successful validation reports as history and rejects stale validations", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    env.INTERNAL_ARTIFACTS_BUCKET.objects.delete("frame_0.jpg");
    const failed = await (await validate(prepared)).json();
    expect(failed.validation.integrity.valid).toBe(false); expect(failed.data.revision).toBe(1);
    const intact = env.INTERNAL_ARTIFACTS_BUCKET.objects.get("frame_1.jpg");
    env.INTERNAL_ARTIFACTS_BUCKET.objects.set("frame_0.jpg", intact);
    expect((await validate(prepared, 0)).status).toBe(412);
    const passing = await (await validate(prepared, 1)).json();
    expect(passing.validation.passed).toBe(true);
    const detail = (await (await call(env, `${base}/${truth.id}`)).json()).data;
    expect(detail.validations).toHaveLength(2);
    expect(detail.latest_validation_id).toBe(passing.validation.id);
    expect((await call(env, `${base}/${truth.id}/validations/${failed.validation.id}/report`)).status).toBe(200);
  });

  it("requires passing validation, explicit attestations, a named reference, and diagnostic scope", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", approveBody, "test-admin", 0)).status).toBe(409);
    await validate(prepared);
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", { ...approveBody, actor_reference: "" }, "test-admin", 1)).status).toBe(400);
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", { ...approveBody, attestations: {} }, "test-admin", 1)).status).toBe(400);
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", { ...approveBody, scope: "commercial" }, "test-admin", 1)).status).toBe(400);
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", approveBody)).status).toBe(428);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_decisions").get().n).toBe(0);
  });

  it("records rejection and requires a new candidate rather than silently reversing it", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    const rejected = await call(env, `${base}/${truth.id}/reject`, "POST", rejectBody, "test-admin", 0);
    expect(rejected.status).toBe(200);
    expect((await rejected.json()).data).toMatchObject({ approval_status: "rejected", status: "invalid", revision: 1 });
    expect((await validate(prepared, 1)).status).toBe(409);
    expect((await getEligibleGroundTruth(env, truth.id)).eligible).toBe(false);
    expect(env.CONTROL_DB.db.prepare("SELECT reason FROM ground_truth_decisions").get().reason).toBe(rejectBody.reason);
  });

  it("permits only one concurrent validation and cleans the losing report object", async () => {
    const prepared = await candidate();
    const responses = await Promise.all([validate(prepared), validate(prepared)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(prepared.env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_validations").get().n).toBe(1);
    expect([...prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.keys()].filter((key) => key.includes('/validations/'))).toHaveLength(1);
  });

  it("permits only one concurrent approval/rejection decision and audit entry", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    await validate(prepared);
    const responses = await Promise.all([call(env, `${base}/${truth.id}/approve`, "POST", approveBody, "test-admin", 1), call(env, `${base}/${truth.id}/reject`, "POST", rejectBody, "test-admin", 1)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_decisions").get().n).toBe(1);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_audit_events WHERE action IN ('ground_truth.approve', 'ground_truth.reject')").get().n).toBe(1);
  });

  it.each([
    ["candidate bytes", (prepared) => { const key = prepared.env.CONTROL_DB.db.prepare("SELECT storage_key FROM artifacts WHERE kind = 'ground_truth'").get().storage_key; prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.get(key).bytes[0] = 120; }],
    ["validation report bytes", (prepared) => { const key = prepared.env.CONTROL_DB.db.prepare("SELECT report_storage_key FROM ground_truth_validations").get().report_storage_key; prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.get(key).bytes[0] = 120; }],
    ["private evidence metadata", (prepared) => { prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.get('frame_0.jpg').httpMetadata.contentType = 'image/png'; }],
    ["frozen policy definition", (prepared) => prepared.env.CONTROL_DB.db.exec("DROP TRIGGER immutable_policy_definition; UPDATE policy_versions SET definition_json = '{}' ")],
    ["review assignment status", (prepared) => prepared.env.CONTROL_DB.db.exec("UPDATE campaign_assignments SET status = 'in_progress' WHERE role = 'reviewer-a'")],
  ])("refuses approval and evaluation eligibility after changed %s", async (_label, damage) => {
    const prepared = await candidate(), { env, truth } = prepared;
    await validate(prepared); damage(prepared);
    const response = await call(env, `${base}/${truth.id}/approve`, "POST", approveBody, "test-admin", 1);
    expect(response.status).toBe(422);
    // Even a status label alone cannot bypass evidence checks.
    env.CONTROL_DB.db.exec("UPDATE ground_truth_versions SET status = 'approved', approval_status = 'approved', approval_scope = 'diagnostic'");
    expect((await getEligibleGroundTruth(env, truth.id)).eligible).toBe(false);
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_decisions").get().n).toBe(0);
  });

  it("supersedes approval only with an eligible replacement over the same frozen template", async () => {
    const first = await candidate(), initial = await approved(first), second = await candidate(first), replacement = await approved(second);
    expect((await call(first.env, `${base}/${first.truth.id}/supersede`, "POST", { ...rejectBody, replacement_id: first.truth.id }, "test-admin", initial.revision)).status).toBe(400);
    const superseded = await call(first.env, `${base}/${first.truth.id}/supersede`, "POST", { ...rejectBody, replacement_id: second.truth.id }, "test-admin", initial.revision);
    expect(superseded.status).toBe(200);
    expect((await superseded.json()).data).toMatchObject({ status: "superseded", approval_status: "superseded", superseded_by_id: replacement.id });
    expect((await getEligibleGroundTruth(first.env, first.truth.id)).eligible).toBe(false);
    expect((await getEligibleGroundTruth(first.env, second.truth.id)).eligible).toBe(true);
    expect((await validate(first, 3)).status).toBe(409);
  });

  it("rolls back validation and decision failures with no partial state or orphan report", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    env.CONTROL_DB.db.exec("CREATE TRIGGER reject_validation BEFORE INSERT ON ground_truth_validations BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await validate(prepared)).status).toBe(500);
    expect(env.CONTROL_DB.db.prepare("SELECT status, revision FROM ground_truth_versions").get()).toMatchObject({ status: "candidate", revision: 0 });
    expect(env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM internal_jobs WHERE job_type = 'validation'").get().n).toBe(0);
    expect([...env.INTERNAL_ARTIFACTS_BUCKET.objects.keys()].filter((key) => key.includes('/validations/'))).toHaveLength(0);
    env.CONTROL_DB.db.exec("DROP TRIGGER reject_validation"); await validate(prepared);
    env.CONTROL_DB.db.exec("CREATE TRIGGER reject_decision BEFORE INSERT ON ground_truth_decisions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await call(env, `${base}/${truth.id}/approve`, "POST", approveBody, "test-admin", 1)).status).toBe(500);
    expect(env.CONTROL_DB.db.prepare("SELECT status, approval_status, revision FROM ground_truth_versions").get()).toMatchObject({ status: "valid", approval_status: "pending", revision: 1 });
  });

  it("protects all governance routes and scopes reports to their candidate", async () => {
    const prepared = await candidate(), { env, truth } = prepared;
    expect((await call(env, base, "GET", undefined, null)).status).toBe(401);
    expect((await call(env, `${base}/${truth.id}/validate`, "POST", {}, prepared.created.invitations['reviewer-a'].api_token, 0)).status).toBe(401);
    const report = await (await validate(prepared)).json(), other = await candidate(prepared);
    expect((await call(env, `${base}/${other.truth.id}/validations/${report.validation.id}/report`)).status).toBe(404);
    expect((await (await call(env, `${base}?limit=1`)).json()).pagination.has_more).toBe(true);
    expect((await call(env, `${base}?offset=9007199254740992`)).status).toBe(400);
  });

  it("keeps policy profile changes immutable and canonicalizes frozen digest ordering", async () => {
    const prepared = await fixture({ sourceCount: 5 });
    const profile = { id: "coco-object-diagnostic.v1", source_sha256: prepared.manifest.sources.map((source) => source.source_sha256).reverse() };
    expect((await registryCall(prepared.env, "/policies", "POST", { ...policyInput, validation_profile: profile })).status).toBe(409);
    const registered = await registryCall(prepared.env, "/policies", "POST", { ...policyInput, version: "profiled-v2", validation_profile: profile });
    expect(registered.status).toBe(201);
    const policy = (await registered.json()).data;
    expect(policy.sha256).not.toBe(prepared.registered.sha256);
    expect(policy.validation_profile.source_sha256).toEqual([...profile.source_sha256].sort());
    expect((await registryCall(prepared.env, "/policies", "POST", { ...policyInput, version: "bad-profile", validation_profile: { ...profile, minimum_objects: 1 } })).status).toBe(400);
  });

  it("checks evidence and decision history after a real approval, rather than trusting its label", async () => {
    const prepared = await candidate(); await approved(prepared);
    expect((await getEligibleGroundTruth(prepared.env, prepared.truth.id)).eligible).toBe(true);
    const source = prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.get("frame_0.jpg");
    prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.delete("frame_0.jpg");
    const missing = await getEligibleGroundTruth(prepared.env, prepared.truth.id);
    expect(missing.eligible).toBe(false); expect(missing.reasons.join(" ")).toContain("private frame evidence");
    prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.set("frame_0.jpg", source);
    prepared.env.CONTROL_DB.db.exec("UPDATE ground_truth_decisions SET attestation_json = '{}' ");
    const missingAttestations = await getEligibleGroundTruth(prepared.env, prepared.truth.id);
    expect(missingAttestations.eligible).toBe(false); expect(missingAttestations.reasons.join(" ")).toContain("attestations");
    prepared.env.CONTROL_DB.db.exec("DELETE FROM ground_truth_decisions");
    const noDecision = await getEligibleGroundTruth(prepared.env, prepared.truth.id);
    expect(noDecision.eligible).toBe(false); expect(noDecision.reasons.join(" ")).toContain("approval evidence");
  });

  it("rejects a validation overtaken by a human rejection during report upload", async () => {
    const prepared = await candidate(), originalPut = prepared.env.INTERNAL_ARTIFACTS_BUCKET.put.bind(prepared.env.INTERNAL_ARTIFACTS_BUCKET);
    prepared.env.INTERNAL_ARTIFACTS_BUCKET.put = async (key, ...args) => {
      await originalPut(key, ...args);
      if (key.includes('/validations/')) expect((await call(prepared.env, `${base}/${prepared.truth.id}/reject`, "POST", rejectBody, "test-admin", 0)).status).toBe(200);
    };
    expect((await validate(prepared)).status).toBe(412);
    expect(prepared.env.CONTROL_DB.db.prepare("SELECT approval_status FROM ground_truth_versions").get().approval_status).toBe("rejected");
    expect(prepared.env.CONTROL_DB.db.prepare("SELECT COUNT(*) AS n FROM ground_truth_validations").get().n).toBe(0);
    expect([...prepared.env.INTERNAL_ARTIFACTS_BUCKET.objects.keys()].filter((key) => key.includes('/validations/'))).toHaveLength(0);
  });

  it("does not supersede a version with approval over a different frozen template", async () => {
    const first = await candidate(); const initial = await approved(first);
    const newPolicy = (await (await registryCall(first.env, "/policies", "POST", { ...policyInput, version: "different-v2", validation_profile: first.registered.validation_profile })).json()).data;
    const newTemplate = (await (await registryCall(first.env, "/templates", "POST", templateInput(newPolicy.id))).json()).data;
    const other = await candidate({ ...first, template: newTemplate }); await approved(other);
    expect((await call(first.env, `${base}/${first.truth.id}/supersede`, "POST", { ...rejectBody, replacement_id: other.truth.id }, "test-admin", initial.revision)).status).toBe(409);
    expect((await getEligibleGroundTruth(first.env, first.truth.id)).eligible).toBe(true);
  });

  it("enforces source concentration even when all other corpus thresholds pass", async () => {
    const prepared = await candidate(), { env, template, registered, truth } = prepared;
    const candidateArtifact = (await (await call(env, `${base}/${truth.id}/artifact`)).json());
    const concentrated = clone(candidateArtifact), source = concentrated.sources[0];
    source.frames[0].objects = concentrated.sources.flatMap((entry) => entry.frames[0].objects);
    concentrated.sources.slice(1).forEach((entry) => { entry.frames[0].objects = []; });
    const loadedTemplate = (await (await call(env, `/api/internal/v1/templates/${template.id}/artifact`)).json());
    const report = validateGroundTruthContent(loadedTemplate, concentrated, registered.validation_profile);
    expect(report.valid).toBe(true); expect(report.corpus_adequacy_gates.source_concentration).toBe(false);
    expect(report.corpus_adequacy_shortfalls.source_concentration.actual).toBe(1);
  });
});
