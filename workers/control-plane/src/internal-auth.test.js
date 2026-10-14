/** @type test @purpose Verify email-link bootstrap, sessions, invitations, and role eligibility. */
import { describe, expect, it } from "vitest";
import { environment } from "./registry-test-support";
import { canAccessInternals, handleIdentityApi, resolveInternalActor } from "./internal-auth";

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
  it("keeps administrator-token authentication primary while allowing it to administer named roles", async () => {
    const env = environment();
    env.INTERNAL_AUTH_MODE = "legacy";
    const sent = [];
    Object.assign(env, {
      EMAIL: { send: async (message) => { sent.push(message); } },
      EMAIL_FROM: "noreply@example.test",
      PUBLIC_BASE_URL: "https://internal.test",
    });
    const headers = { origin: "https://internal.test", authorization: "Bearer test-admin" };
    const status = await call(env, request("/api/internal/v1/auth/status"));
    expect((await status.json()).data.authentication).toBe("administrator_token");

    const created = await call(env, request("/api/internal/v1/users", "POST", {
      email: "operator@example.test",
      display_name: "Named Operator",
      roles: ["operator"],
    }, headers));
    expect(created.status).toBe(201);
    expect(sent).toHaveLength(1);
    const identity = (await created.json()).data;
    expect(identity).toMatchObject({ email: "operator@example.test", roles: ["operator"], email_verified: false });
    const listed = await call(env, request("/api/internal/v1/users", "GET", undefined, { authorization: "Bearer test-admin" }));
    expect((await listed.json()).data).toEqual([expect.objectContaining({ id: identity.id, roles: ["operator"], email_verified: false })]);
    const audit = env.CONTROL_DB.db.prepare("SELECT actor_user_id, details_json FROM internal_audit_events WHERE action = 'identity.invite'").get();
    expect(audit.actor_user_id).toBeNull();
    expect(JSON.parse(audit.details_json).authentication).toBe("legacy_administrator_token");
  });

  it("applies the role matrix to named users and denies unmatched operations", () => {
    const actor = (role) => ({ kind: "user", user: { id: "user_test", email: "user@example.test", display_name: "User", roles: [role] } });
    const allowed = (role, path, method = "GET") => canAccessInternals(actor(role), request(path, method));
    expect(allowed("operator", "/api/internal/v1/datasets")).toBe(true);
    expect(allowed("operator", "/api/internal/v1/datasets", "POST")).toBe(true);
    expect(allowed("researcher", "/api/internal/v1/datasets", "POST")).toBe(false);
    expect(allowed("researcher", "/api/internal/v1/ground-truth/gt_test/validate", "POST")).toBe(true);
    expect(allowed("researcher", "/api/internal/v1/ground-truth/gt_test/approve", "POST")).toBe(false);
    expect(allowed("release_approver", "/api/internal/v1/ground-truth/gt_test/approve", "POST")).toBe(true);
    expect(allowed("reviewer", "/api/internal/v1/review-campaigns")).toBe(false);
    expect(allowed("review_coordinator", "/api/internal/v1/review-campaigns", "POST")).toBe(true);
    expect(allowed("operator", "/api/internal/v1/unregistered-operation")).toBe(false);
  });

  it("exchanges the administrator bearer for a short-lived browser-session cookie", async () => {
    const env = environment();
    env.INTERNAL_AUTH_MODE = "legacy";
    const origin = { origin: "https://internal.test" };
    const issued = await call(env, request("/api/internal/v1/auth/admin-session", "POST", undefined, {
      ...origin,
      authorization: "Bearer test-admin",
    }));
    expect(issued.status).toBe(200);
    const setCookie = issued.headers.get("set-cookie");
    expect(setCookie).toContain("internals_admin_session=");
    expect(setCookie).toContain("Path=/api/internal/v1");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Max-Age");

    const sessionCookie = setCookie.split(";", 1)[0];
    const overview = request("/api/internal/v1/overview", "GET", undefined, { cookie: sessionCookie });
    expect(await resolveInternalActor(overview, env)).toEqual({ kind: "legacy_admin" });

    const crossOriginWrite = request("/api/internal/v1/datasets", "POST", undefined, { cookie: sessionCookie, origin: "https://attacker.test" });
    expect(await resolveInternalActor(crossOriginWrite, env)).toBeNull();

    const logout = await call(env, request("/api/internal/v1/auth/logout", "POST", undefined, { ...origin, cookie: sessionCookie }));
    expect(logout.headers.get("set-cookie")).toContain("internals_admin_session=; Path=/api/internal/v1; Max-Age=0");
  });

  it("rejects invalid admin-session exchanges and the email-only mode", async () => {
    const env = environment();
    env.INTERNAL_AUTH_MODE = "legacy";
    const invalid = await call(env, request("/api/internal/v1/auth/admin-session", "POST", undefined, {
      origin: "https://internal.test",
      authorization: "Bearer wrong-token",
    }));
    expect(invalid.status).toBe(401);

    env.INTERNAL_AUTH_MODE = "sessions";
    const disabled = await call(env, request("/api/internal/v1/auth/admin-session", "POST", undefined, {
      origin: "https://internal.test",
      authorization: "Bearer test-admin",
    }));
    expect(disabled.status).toBe(401);
  });

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
