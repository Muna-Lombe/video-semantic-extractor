/** @type test @purpose Verify email-link bootstrap, sessions, invitations, and role eligibility. */
import { describe, expect, it } from "vitest";
import { environment } from "./registry-test-support";
import { handleIdentityApi } from "./internal-auth";

function request(path, method = "GET", payload, headers = {}) {
  return new Request(`https://internal.test${path}`, {
    method,
    headers: { ...headers, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function call(env, req) {
  const response = await handleIdentityApi(req, env);
  if (!response) throw new Error(`No identity route matched ${new URL(req.url).pathname}`);
  return response;
}

function tokenFrom(email) {
  const link = email.html.match(/href="([^"]+)"/)?.[1];
  if (!link) throw new Error("verification email did not contain a link");
  const token = new URL(link).hash.match(/auth-token=([^&]+)/)?.[1];
  if (!token) throw new Error("verification link did not contain an auth token");
  return decodeURIComponent(token);
}

describe("Internals identity", () => {
  it("bootstraps a verified owner, invites named reviewers, and requires a session in sessions mode", async () => {
    const env = environment();
    const sent = [];
    Object.assign(env, {
      EMAIL: { send: async (message) => { sent.push(message); } },
      EMAIL_FROM: "noreply@katundu.org",
      PUBLIC_BASE_URL: "https://internal.test",
      INTERNAL_AUTH_MODE: "sessions",
    });
    const origin = { origin: "https://internal.test" };

    const setup = await call(env, request("/api/internal/v1/auth/status"));
    expect((await setup.json()).data.bootstrap_available).toBe(true);

    const bootstrapped = await call(env, request("/api/internal/v1/auth/bootstrap", "POST", {
      email: "owner@example.test",
      display_name: "Initial Owner",
    }, { ...origin, authorization: "Bearer test-admin" }));
    expect(bootstrapped.status).toBe(202);
    expect(sent[0].to).toBe("owner@example.test");

    const ownerVerified = await call(env, request("/api/internal/v1/auth/verify", "POST", { token: tokenFrom(sent[0]) }, origin));
    expect(ownerVerified.status).toBe(200);
    const ownerCookie = ownerVerified.headers.get("set-cookie").split(";", 1)[0];

    const invited = await call(env, request("/api/internal/v1/users", "POST", {
      email: "reviewer@example.test",
      display_name: "Named Reviewer",
      roles: ["reviewer"],
    }, { ...origin, cookie: ownerCookie }));
    expect(invited.status).toBe(201);
    expect(sent[1].to).toBe("reviewer@example.test");

    const pendingReviewers = await call(env, request("/api/internal/v1/reviewers", "GET", undefined, { cookie: ownerCookie }));
    expect((await pendingReviewers.json()).data).toEqual([]);

    const reviewerVerified = await call(env, request("/api/internal/v1/auth/verify", "POST", { token: tokenFrom(sent[1]) }, origin));
    expect(reviewerVerified.status).toBe(200);

    const reviewers = await call(env, request("/api/internal/v1/reviewers", "GET", undefined, { cookie: ownerCookie }));
    expect((await reviewers.json()).data).toEqual([
      expect.objectContaining({ email: "reviewer@example.test", roles: ["reviewer"] }),
    ]);

    const legacyAccess = await call(env, request("/api/internal/v1/users", "GET", undefined, { authorization: "Bearer test-admin" }));
    expect(legacyAccess.status).toBe(401);
  });

  it("allows the bootstrap owner to retry verification email delivery after a send failure", async () => {
    const env = environment();
    let attempts = 0;
    Object.assign(env, {
      EMAIL: { send: async () => { if (++attempts === 1) throw new Error("temporary email failure"); } },
      EMAIL_FROM: "noreply@katundu.org",
      PUBLIC_BASE_URL: "https://internal.test",
    });
    const headers = { origin: "https://internal.test", authorization: "Bearer test-admin" };
    const body = { email: "owner@example.test", display_name: "Initial Owner" };

    const failed = await call(env, request("/api/internal/v1/auth/bootstrap", "POST", body, headers));
    expect(failed.status).toBe(503);
    const retry = await call(env, request("/api/internal/v1/auth/bootstrap", "POST", body, headers));
    expect(retry.status).toBe(202);
    expect(attempts).toBe(2);
  });
});
