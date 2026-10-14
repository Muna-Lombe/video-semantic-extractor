/** @type test @purpose Verify transactional campaigns, independent reviews, revocation races, and candidate results. */
import { beforeEach, afterEach, expect, vi } from "vitest";
import worker from "./adjudication";
import { environment, call as registryCall, policy, frameSet, templateInput, policyInput } from "./registry-test-support";
const clone = (value) => JSON.parse(JSON.stringify(value));
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

async function call(env, path, method = "GET", payload, token = "test-admin", revision) {
  return worker.fetch(new Request(`https://internal.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(revision === undefined ? {} : { "if-match": String(revision) }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), env);
}
async function callWithHeaders(env, path, method = "GET", payload, headers = {}) {
  return worker.fetch(new Request(`https://internal.test${path}`, {
    method,
    headers: { ...headers, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }), env);
}

async function fixture(options = {}) {
  const env = environment(), manifest = await frameSet(env, options.sourceCount ?? 1);
  const profile = options.validation_profile ?? (options.profile ? { id: "coco-object-diagnostic.v1", source_sha256: manifest.sources.map((source) => source.source_sha256) } : undefined);
  const registered = await policy(env, { ...policyInput, ...(profile ? { validation_profile: profile } : {}) });
  const template = (await (await registryCall(env, "/templates", "POST", templateInput(registered.id))).json()).data;
  return { env, template, registered, manifest };
}
async function campaign(env, template, name = "Independent diagnostic review", key) {
  const response = await call(env, "/api/internal/v1/review-campaigns", "POST", { name, template_id: template.id, issue_tokens: false, ...(key ? { idempotency_key: key } : {}) });
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(created).not.toHaveProperty("invitations");
  created.invitations = {};
  for (const role of ["reviewer-a", "reviewer-b", "adjudicator"]) {
    const issued = await call(env, `/api/internal/v1/review-campaigns/${created.data.id}/assignments/${role}/issue`, "POST");
    expect(issued.status).toBe(200);
    created.invitations[role] = (await issued.json()).invitation;
  }
  return created;
}
const reviewerPath = (invitation) => `/api/v1/assignments/${invitation.assignment_id}`;
const adjudicatorPath = (invitation) => `/api/v1/adjudications/${invitation.assignment_id}`;
async function state(env, invitation) {
  const path = invitation.url.includes("/adjudicate/") ? adjudicatorPath(invitation) : reviewerPath(invitation);
  const response = await call(env, path, "GET", undefined, invitation.api_token);
  expect(response.status).toBe(200);
  return response.json();
}
function annotated(state, label = "person", reviewed = true) {
  const value = clone(state.annotations), source = value.sources[0], frame = source.frames[0];
  frame.objects = label ? [{ id: `${label}-1`, label, subset: "live", region: [1, 2, 20, 30] }] : [];
  value.review.reviewed_frames = reviewed ? [`${source.source}/${frame.filename}`] : [];
  return value;
}
async function save(env, invitation, value, revision = 0) {
  return call(env, reviewerPath(invitation), "PUT", value, invitation.api_token, revision);
}
async function finishReview(env, invitation, label) {
  const initial = await state(env, invitation), response = await save(env, invitation, annotated(initial, label), initial.revision);
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect((await call(env, `${reviewerPath(invitation)}/complete`, "POST", {}, invitation.api_token, saved.revision)).status).toBe(200);
}
async function ready(env, created, labelA = "person", labelB = "chair") {
  await Promise.all([finishReview(env, created.invitations["reviewer-a"], labelA), finishReview(env, created.invitations["reviewer-b"], labelB)]);
  return state(env, created.invitations.adjudicator);
}
const adminBase = "/api/internal/v1/review-campaigns";


export { fixture, campaign, call, callWithHeaders, state, save, ready, finishReview, reviewerPath, adjudicatorPath };
