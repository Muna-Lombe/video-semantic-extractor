/** @type implementation @purpose Authenticate named Internals users and enforce role-based access. */
import type { AdjudicationEnv } from "./types";

export type InternalRole = "owner" | "operator" | "researcher" | "review_coordinator" | "reviewer" | "adjudicator" | "release_approver";
export interface InternalUser {
  id: string;
  email: string;
  display_name: string;
  roles: InternalRole[];
}
export type InternalActor = { kind: "user"; user: InternalUser } | { kind: "legacy_admin" };

const COOKIE = "internals_session";
const ADMIN_COOKIE = "internals_admin_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const ADMIN_SESSION_SECONDS = 60 * 60 * 12;
const CHALLENGE_SECONDS = 60 * 30;
const BASE = "/api/internal/v1/auth";
const ADMIN_SESSION_PURPOSE = "internals-admin-session-v1";
const ROLES = new Set<InternalRole>(["owner", "operator", "researcher", "review_coordinator", "reviewer", "adjudicator", "release_approver"]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const fail = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
const legacyEnabled = (env: AdjudicationEnv) => env.INTERNAL_AUTH_MODE !== "sessions";

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === name) return value.join("=") || null;
  }
  return null;
}

const cookie = (request: Request) => cookieValue(request, COOKIE);

async function adminSessionKey(env: AdjudicationEnv, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  } catch {
    return null;
  }
}

async function createAdminSessionToken(env: AdjudicationEnv): Promise<string> {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("HMAC", await adminSessionKey(env, ["sign"]), new TextEncoder().encode(`${ADMIN_SESSION_PURPOSE}:${issuedAt}`));
  return `${issuedAt}.${base64Url(new Uint8Array(signature))}`;
}

async function validAdminSession(request: Request, env: AdjudicationEnv): Promise<boolean> {
  const rawToken = cookieValue(request, ADMIN_COOKIE);
  const [issuedAt, encodedSignature, ...extra] = rawToken?.split(".") ?? [];
  if (!env.ADMIN_TOKEN || extra.length || !/^\d{10}$/.test(issuedAt ?? "") || !encodedSignature) return false;
  const timestamp = Number(issuedAt);
  const age = Math.floor(Date.now() / 1000) - timestamp;
  const signature = decodeBase64Url(encodedSignature);
  if (!Number.isSafeInteger(timestamp) || age < -30 || age >= ADMIN_SESSION_SECONDS || !signature) return false;
  return crypto.subtle.verify(
    "HMAC",
    await adminSessionKey(env, ["verify"]),
    signature,
    new TextEncoder().encode(`${ADMIN_SESSION_PURPOSE}:${issuedAt}`),
  );
}

function responseWithAdminSession(response: Response, token: string): Response {
  response.headers.append("set-cookie", `${ADMIN_COOKIE}=${token}; Path=/api/internal/v1; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

function clearAdminSessionCookie(response: Response): Response {
  response.headers.append("set-cookie", `${ADMIN_COOKIE}=; Path=/api/internal/v1; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

async function resendInvitation(request: Request, env: AdjudicationEnv, userId: string): Promise<Response> {
    const actor = await ownerRequired(request, env);
    if (actor instanceof Response) return actor;
    if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
    const user = await env.CONTROL_DB.prepare("SELECT id, email FROM internal_users WHERE id = ? AND status = 'active' AND email_verified_at IS NULL").bind(userId).first<{ id: string; email: string }>();
    if (!user) return fail("user_not_invitable", "active, unverified user not found", 404);
    try {
      await sendChallengeResponse(request, env, user.id, user.email, "verify_email");
    } catch (cause) {
      console.error({ event: "identity_email_send_failed", purpose: "verify_email", error_name: cause instanceof Error ? cause.name : "UnknownError" });
      return fail("email_unavailable", "could not send the verification email; try again later", 503);
    }
    await env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'identity.invitation_resent', 'internal_user', ?, ?, ?)")
        .bind(actor.kind === "user" ? actor.user.id : null, user.id, JSON.stringify({ email: user.email, authentication: actor.kind === "user" ? "email_link_session" : "legacy_administrator_token" }), now()).run();
    return json({ data: { id: user.id, email: user.email, verification_sent: true } }, 202);
  }

async function updateUser(request: Request, env: AdjudicationEnv, userId: string): Promise<Response> {
    const actor = await ownerRequired(request, env);
    if (actor instanceof Response) return actor;
    if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
    const value = await requestBody(request);
    if (value instanceof Response) return value;
    if (Object.keys(value).some((key) => !["roles", "status", "display_name"].includes(key)) ||
        (value.status !== undefined && value.status !== "active" && value.status !== "disabled") ||
        (value.display_name !== undefined && (typeof value.display_name !== "string" || !value.display_name.trim() || value.display_name.trim().length > 120)) ||
        (value.roles !== undefined && (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > ROLES.size || value.roles.some((role) => typeof role !== "string" || !ROLES.has(role as InternalRole)) || new Set(value.roles).size !== value.roles.length)) ||
        (value.status === undefined && value.display_name === undefined && value.roles === undefined)) {
      return fail("invalid_request", "provide a valid role list, status, or display name", 400);
    }
    const target = await env.CONTROL_DB.prepare("SELECT id, status, display_name FROM internal_users WHERE id = ?").bind(userId).first<{ id: string; status: string; display_name: string }>();
    if (!target) return fail("user_not_found", "user not found", 404);
    const currentRoles = await env.CONTROL_DB.prepare("SELECT role FROM internal_user_roles WHERE user_id = ?").bind(userId).all<{ role: string }>();
    const nextRoles = value.roles as InternalRole[] | undefined ?? currentRoles.results.map(({ role }) => role as InternalRole);
    const nextStatus = value.status as "active" | "disabled" | undefined ?? target.status as "active" | "disabled";
    if (!nextRoles.length) return fail("roles_required", "an account must retain at least one role", 400);
    if (actor.kind === "user" && target.id === actor.user.id && (nextStatus !== "active" || !nextRoles.includes("owner"))) return fail("cannot_remove_self", "you cannot disable or remove your own owner access", 409);
    if ((target.status === "active" && currentRoles.results.some(({ role }) => role === "owner")) && (nextStatus !== "active" || !nextRoles.includes("owner"))) {
      const otherOwners = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM internal_user_roles r JOIN internal_users u ON u.id = r.user_id WHERE r.role = 'owner' AND u.status = 'active' AND u.id != ?").bind(userId).first<{ count: number }>();
      if (Number(otherOwners?.count ?? 0) === 0) return fail("last_owner", "at least one active owner must remain", 409);
    }
    const timestamp = now();
    const statements = [
      env.CONTROL_DB.prepare("UPDATE internal_users SET status = ?, display_name = ?, updated_at = ? WHERE id = ?").bind(nextStatus, typeof value.display_name === "string" ? value.display_name.trim() : target.display_name, timestamp, userId),
      env.CONTROL_DB.prepare("DELETE FROM internal_user_roles WHERE user_id = ?").bind(userId),
      ...nextRoles.map((role) => env.CONTROL_DB.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, ?, ?)").bind(userId, role, timestamp)),
      ...(nextStatus === "disabled" ? [env.CONTROL_DB.prepare("UPDATE internal_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(timestamp, userId)] : []),
      env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'identity.user_updated', 'internal_user', ?, ?, ?)")
        .bind(actor.kind === "user" ? actor.user.id : null, userId, JSON.stringify({ roles: nextRoles, status: nextStatus, display_name_changed: value.display_name !== undefined, authentication: actor.kind === "user" ? "email_link_session" : "legacy_administrator_token" }), timestamp),
    ];
    await env.CONTROL_DB.batch(statements);
    return json({ data: { id: userId, status: nextStatus, roles: nextRoles, ...(typeof value.display_name === "string" ? { display_name: value.display_name.trim() } : {}) } });
  }

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function requestBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return fail("unsupported_media_type", "content-type must be application/json", 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 16 * 1024) return fail("request_too_large", "request body is too large", 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) return fail("request_too_large", "request body is too large", 413);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_request", "request body must be a JSON object", 400);
    return value as Record<string, unknown>;
  } catch {
    return fail("invalid_json", "request body is not valid JSON", 400);
  }
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function responseWithSession(payload: unknown, rawToken: string): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": `${COOKIE}=${rawToken}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    },
  });
}

function clearSessionCookie(response: Response): Response {
  response.headers.append("set-cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
  return response;
}

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function baseUrl(request: Request, env: AdjudicationEnv): URL {
  const configured = env.PUBLIC_BASE_URL;
  const origin = configured ? new URL(configured) : new URL(request.url);
  if (origin.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS");
  return origin;
}

async function sendLink(env: AdjudicationEnv, request: Request, email: string, rawToken: string, purpose: "verify_email" | "sign_in"): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM) throw new Error("Cloudflare Email Service binding and EMAIL_FROM are required");
  const url = baseUrl(request, env);
  url.pathname = "/internals/";
  url.hash = `auth-token=${encodeURIComponent(rawToken)}`;
  const subject = purpose === "verify_email" ? "Verify your Internals account" : "Sign in to Internals";
  const action = purpose === "verify_email" ? "verify your email address and sign in" : "sign in to Internals";
  const link = url.toString();
  await env.EMAIL.send({
    from: env.EMAIL_FROM,
    to: email,
    subject,
    text: `Use this one-time link to ${action}:\n\n${link}\n\nIt expires in 30 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Use this one-time link to ${action}:</p><p><a href="${link}">Continue to Internals</a></p><p>It expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
  });
}

async function createChallenge(env: AdjudicationEnv, userId: string, purpose: "verify_email" | "sign_in"): Promise<string> {
  const rawToken = randomToken(), timestamp = now();
  await env.CONTROL_DB.prepare("INSERT INTO internal_auth_challenges (id, user_id, token_hash, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id("authc"), userId, await sha256(rawToken), purpose, timestamp, new Date(Date.now() + CHALLENGE_SECONDS * 1000).toISOString()).run();
  return rawToken;
}

export async function resolveInternalUser(request: Request, env: AdjudicationEnv): Promise<InternalUser | null> {
  const rawToken = cookie(request);
  if (!rawToken) return null;
  const row = await env.CONTROL_DB.prepare(`SELECT u.id, u.email, u.display_name,
      GROUP_CONCAT(r.role) AS roles
    FROM internal_sessions s
    JOIN internal_users u ON u.id = s.user_id
    JOIN internal_user_roles r ON r.user_id = u.id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND u.status = 'active' AND u.email_verified_at IS NOT NULL
    GROUP BY u.id, u.email, u.display_name`)
    .bind(await sha256(rawToken), now()).first<{ id: string; email: string; display_name: string; roles: string | null }>();
  if (!row) return null;
  const roles = (row.roles ?? "").split(",").filter((role): role is InternalRole => ROLES.has(role as InternalRole));
  return roles.length ? { id: row.id, email: row.email, display_name: row.display_name, roles } : null;
}

export async function resolveInternalActor(request: Request, env: AdjudicationEnv): Promise<InternalActor | null> {
  const supplied = bearer(request);
  if (legacyEnabled(env) && env.ADMIN_TOKEN && supplied === env.ADMIN_TOKEN) return { kind: "legacy_admin" };
  const path = new URL(request.url).pathname;
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
  const sameOriginWrite = request.headers.get("origin") === new URL(request.url).origin;
  if (legacyEnabled(env) && path.startsWith("/api/internal/v1/") && (safeMethod || sameOriginWrite) && await validAdminSession(request, env)) {
    return { kind: "legacy_admin" };
  }
  const user = await resolveInternalUser(request, env);
  if (user && !safeMethod && !sameOriginWrite) return null;
  if (user) return { kind: "user", user };
  return null;
}

export function canAccessInternals(actor: InternalActor, request: Request): boolean {
  if (actor.kind === "legacy_admin" || actor.user.roles.includes("owner")) return true;
  const roles = new Set(actor.user.roles);
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const method = request.method.toUpperCase();
  if (path === "/api/internal/v1/overview") return roles.size > 0;
  if (path.startsWith("/api/internal/v1/operations")) return roles.has("operator");
  if (/^\/api\/internal\/v1\/(models|releases)(\/|$)/.test(path)) {
    if (method === "GET") return ["operator", "researcher", "release_approver"].some((role) => roles.has(role as InternalRole));
    if (/\/(approve|reject|activate|rollback|retire)$/.test(path)) return roles.has("release_approver");
    return roles.has("researcher");
  }
  if (path.startsWith(`${BASE}/users`)) return roles.has("owner");
  if (path === "/api/internal/v1/reviewers") return roles.has("review_coordinator");
  if (path.startsWith("/api/internal/v1/pipelines")) {
    if (method === "GET") return ["operator", "researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole));
    return ["operator", "researcher", "review_coordinator"].some((role) => roles.has(role as InternalRole));
  }
  if (path.startsWith("/api/internal/v1/evaluations")) {
    if (method === "GET") return ["operator", "researcher", "release_approver"].some((role) => roles.has(role as InternalRole));
    return ["researcher", "operator"].some((role) => roles.has(role as InternalRole));
  }
  if (path.startsWith("/api/internal/v1/datasets")) return method === "GET" ? ["operator", "researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole)) : roles.has("operator");
  if (path.startsWith("/api/internal/v1/sampling-jobs")) return method === "GET" ? ["operator", "researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole)) : roles.has("operator");
  if (path === "/api/internal/v1/runners") return ["operator", "researcher", "review_coordinator"].some((role) => roles.has(role as InternalRole));
  if (path.startsWith("/api/internal/v1/frame-sets")) return ["operator", "researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole));
  if (path.startsWith("/api/internal/v1/policies") || path.startsWith("/api/internal/v1/templates")) return method === "GET" ? ["researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole)) : roles.has("researcher");
  if (path.startsWith("/api/internal/v1/review-campaigns")) return roles.has("review_coordinator");
  if (path.startsWith("/api/internal/v1/ground-truth")) {
    if (method === "GET") return ["researcher", "review_coordinator", "release_approver"].some((role) => roles.has(role as InternalRole));
    if (path.endsWith("/validate")) return roles.has("researcher");
    return roles.has("release_approver");
  }
  return false;
}

async function ownerRequired(request: Request, env: AdjudicationEnv): Promise<InternalActor | Response> {
  const actor = await resolveInternalActor(request, env);
  if (!actor) return fail("unauthorized", "verified Internals sign-in required", 401);
  if (actor.kind === "legacy_admin" || actor.user.roles.includes("owner")) return actor;
  return fail("forbidden", "owner role required", 403);
}

async function sendChallengeResponse(request: Request, env: AdjudicationEnv, userId: string, email: string, purpose: "verify_email" | "sign_in"): Promise<void> {
  const rawToken = await createChallenge(env, userId, purpose);
  try {
    await sendLink(env, request, email, rawToken, purpose);
  } catch (cause) {
    await env.CONTROL_DB.prepare("UPDATE internal_auth_challenges SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL")
      .bind(now(), await sha256(rawToken)).run();
    throw cause;
  }
}

async function bootstrap(request: Request, env: AdjudicationEnv): Promise<Response> {
  const supplied = bearer(request);
  if (!env.ADMIN_TOKEN || supplied !== env.ADMIN_TOKEN) return fail("unauthorized", "bootstrap credential required", 401);
  if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
  const value = await requestBody(request);
  if (value instanceof Response) return value;
  const email = normaliseEmail(value.email);
  if (!email || typeof value.display_name !== "string" || !value.display_name.trim() || value.display_name.trim().length > 120) return fail("invalid_request", "a valid email and display name are required", 400);
  const owners = await env.CONTROL_DB.prepare(`SELECT u.id, u.email, u.email_verified_at
    FROM internal_user_roles r JOIN internal_users u ON u.id = r.user_id
    WHERE r.role = 'owner' ORDER BY u.created_at LIMIT 1`).first<{ id: string; email: string; email_verified_at: string | null }>();
  if (owners) {
    if (owners.email !== email || owners.email_verified_at !== null) return fail("bootstrap_closed", "owner bootstrap has already been completed", 409);
    try {
      await sendChallengeResponse(request, env, owners.id, owners.email, "verify_email");
    } catch (cause) {
      console.error({ event: "identity_email_send_failed", purpose: "verify_email", error_name: cause instanceof Error ? cause.name : "UnknownError" });
      return fail("email_unavailable", "could not send the account verification email; retry bootstrap to resend it", 503);
    }
    return json({ data: { email: owners.email, verification_sent: true }, message: "Check your email to verify the owner account." }, 202);
  }
  const existing = await env.CONTROL_DB.prepare("SELECT id FROM internal_users WHERE email = ?").bind(email).first<{ id: string }>();
  if (existing) return fail("bootstrap_conflict", "this email already has an account; ask its owner to resend an invitation", 409);
  const userId = id("user"), timestamp = now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("INSERT INTO internal_users (id, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(userId, email, value.display_name.trim(), timestamp, timestamp),
    env.CONTROL_DB.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, 'owner', ?)").bind(userId, timestamp),
    env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (action, resource_type, resource_id, details_json, created_at) VALUES ('identity.bootstrap', 'internal_user', ?, ?, ?)")
      .bind(userId, JSON.stringify({ email }), timestamp),
  ]);
  try {
    await sendChallengeResponse(request, env, userId, email, "verify_email");
  } catch (cause) {
    console.error({ event: "identity_email_send_failed", purpose: "verify_email", error_name: cause instanceof Error ? cause.name : "UnknownError" });
    return fail("email_unavailable", "could not send the account verification email", 503);
  }
  return json({ data: { email, verification_sent: true }, message: "Check your email to verify the owner account." }, 202);
}

async function createUser(request: Request, env: AdjudicationEnv): Promise<Response> {
  const actor = await ownerRequired(request, env);
  if (actor instanceof Response) return actor;
  if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
  const value = await requestBody(request);
  if (value instanceof Response) return value;
  const email = normaliseEmail(value.email);
  const roles = value.roles;
  if (!email || typeof value.display_name !== "string" || !value.display_name.trim() || value.display_name.trim().length > 120 || !Array.isArray(roles) || roles.length < 1 || roles.length > ROLES.size || roles.some((role) => typeof role !== "string" || !ROLES.has(role as InternalRole)) || new Set(roles).size !== roles.length) return fail("invalid_request", "valid email, display name, and unique roles are required", 400);
  const existing = await env.CONTROL_DB.prepare("SELECT id FROM internal_users WHERE email = ?").bind(email).first<{ id: string }>();
  if (existing) return fail("email_conflict", "an account already exists for this email", 409);
  const userId = id("user"), timestamp = now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("INSERT INTO internal_users (id, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .bind(userId, email, value.display_name.trim(), timestamp, timestamp),
    ...roles.map((role) => env.CONTROL_DB.prepare("INSERT INTO internal_user_roles (user_id, role, created_at) VALUES (?, ?, ?)").bind(userId, role, timestamp)),
    env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'identity.invite', 'internal_user', ?, ?, ?)")
    .bind(actor.kind === "user" ? actor.user.id : null, userId, JSON.stringify({ email, roles, authentication: actor.kind === "user" ? "email_link_session" : "legacy_administrator_token" }), timestamp),
  ]);
  try {
    await sendChallengeResponse(request, env, userId, email, "verify_email");
  } catch (cause) {
    console.error({ event: "identity_email_send_failed", purpose: "verify_email", error_name: cause instanceof Error ? cause.name : "UnknownError" });
    return fail("email_unavailable", "account was created but its verification email could not be sent; use the resend invitation action", 503);
  }
  return json({ data: { id: userId, email, display_name: value.display_name.trim(), roles, email_verified: false }, verification_sent: true }, 201);
}

async function verifyChallenge(request: Request, env: AdjudicationEnv): Promise<Response> {
  if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
  const value = await requestBody(request);
  if (value instanceof Response) return value;
  if (typeof value.token !== "string" || value.token.length < 40 || value.token.length > 200) return fail("invalid_token", "verification token is invalid or expired", 400);
  const tokenHash = await sha256(value.token), timestamp = now(), sessionToken = randomToken(), sessionId = id("session");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  const sessionHash = await sha256(sessionToken);
  const results = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(`UPDATE internal_auth_challenges SET consumed_at = ?, consumed_by_session_id = ?
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (SELECT 1 FROM internal_users WHERE id = internal_auth_challenges.user_id AND status = 'active')`)
      .bind(timestamp, sessionId, tokenHash, timestamp),
    env.CONTROL_DB.prepare(`UPDATE internal_users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
      WHERE id = (SELECT user_id FROM internal_auth_challenges WHERE token_hash = ? AND consumed_by_session_id = ? AND purpose = 'verify_email')
        AND status = 'active'`)
      .bind(timestamp, timestamp, tokenHash, sessionId),
    env.CONTROL_DB.prepare(`INSERT INTO internal_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
      SELECT ?, u.id, ?, ?, ?, ? FROM internal_users u
      WHERE u.id = (SELECT user_id FROM internal_auth_challenges WHERE token_hash = ? AND consumed_by_session_id = ?)
        AND u.status = 'active' AND u.email_verified_at IS NOT NULL`)
      .bind(sessionId, sessionHash, timestamp, expiresAt, timestamp, tokenHash, sessionId),
    env.CONTROL_DB.prepare(`INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, created_at)
      SELECT u.id, 'identity.sign_in', 'internal_user', u.id, ? FROM internal_users u
      WHERE u.id = (SELECT user_id FROM internal_sessions WHERE id = ? AND token_hash = ?)`)
      .bind(timestamp, sessionId, sessionHash),
  ]);
  if (!results[0]?.meta.changes || !results[2]?.meta.changes) return fail("invalid_token", "verification token is invalid or expired", 400);
  const user = await resolveInternalUser(new Request(request.url, { headers: { cookie: `${COOKIE}=${sessionToken}` } }), env);
  if (!user) return fail("email_not_verified", "verify your email before signing in", 403);
  return responseWithSession({ data: user }, sessionToken);
}

async function requestSignIn(request: Request, env: AdjudicationEnv): Promise<Response> {
  if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
  const value = await requestBody(request);
  if (value instanceof Response) return value;
  const email = normaliseEmail(value.email);
  if (!email) return fail("invalid_request", "a valid email address is required", 400);
  const user = await env.CONTROL_DB.prepare("SELECT id, email FROM internal_users WHERE email = ? AND status = 'active' AND email_verified_at IS NOT NULL").bind(email).first<{ id: string; email: string }>();
  if (user) {
    const recent = await env.CONTROL_DB.prepare("SELECT id FROM internal_auth_challenges WHERE user_id = ? AND purpose = 'sign_in' AND created_at > ? AND consumed_at IS NULL LIMIT 1")
      .bind(user.id, new Date(Date.now() - 60_000).toISOString()).first<{ id: string }>();
    if (!recent) {
      try {
        await sendChallengeResponse(request, env, user.id, user.email, "sign_in");
      } catch (cause) {
        console.error({ event: "identity_email_send_failed", purpose: "sign_in", error_name: cause instanceof Error ? cause.name : "UnknownError" });
        return fail("email_unavailable", "could not send a sign-in email; try again later", 503);
      }
    }
  }
  return json({ message: "If the address belongs to a verified Internals account, a sign-in link has been sent." }, 202);
}

async function status(env: AdjudicationEnv): Promise<Response> {
  const owner = await env.CONTROL_DB.prepare(`SELECT 1 AS present
    FROM internal_user_roles r JOIN internal_users u ON u.id = r.user_id
    WHERE r.role = 'owner' AND u.status = 'active' AND u.email_verified_at IS NOT NULL LIMIT 1`).first<{ present: number }>();
  return json({ data: { bootstrap_available: !owner, authentication: env.INTERNAL_AUTH_MODE === "sessions" ? "email_link" : "administrator_token" } });
}

async function createAdminSession(request: Request, env: AdjudicationEnv): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) return fail("origin_invalid", "request origin is invalid", 403);
  const supplied = bearer(request);
  if (!legacyEnabled(env) || !env.ADMIN_TOKEN || supplied !== env.ADMIN_TOKEN) return fail("unauthorized", "administrator token is invalid", 401);
  const token = await createAdminSessionToken(env);
  return responseWithAdminSession(json({ data: { authenticated: true, expires_in_seconds: ADMIN_SESSION_SECONDS } }), token);
}

async function listEligibleAssignees(request: Request, env: AdjudicationEnv): Promise<Response> {
  const actor = await resolveInternalActor(request, env);
  if (!actor) return fail("unauthorized", "verified Internals sign-in required", 401);
  if (!canAccessInternals(actor, request)) return fail("forbidden", "review coordinator role required", 403);
  const rows = await env.CONTROL_DB.prepare(`SELECT u.id, u.email, u.display_name, GROUP_CONCAT(r.role) AS roles
    FROM internal_users u JOIN internal_user_roles r ON r.user_id = u.id
    WHERE u.status = 'active' AND u.email_verified_at IS NOT NULL
    GROUP BY u.id, u.email, u.display_name ORDER BY u.display_name, u.email`)
    .all<{ id: string; email: string; display_name: string; roles: string }>();
  const data = rows.results.map((row) => ({ ...row, roles: row.roles.split(",").filter((role) => ROLES.has(role as InternalRole)) }))
    .filter((user) => user.roles.includes("reviewer") || user.roles.includes("adjudicator"));
  return json({ data });
}

export async function handleIdentityApi(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (path === `${BASE}/status` && request.method === "GET") return status(env);
  if (path === `${BASE}/admin-session` && request.method === "POST") return createAdminSession(request, env);
  if (path === "/api/internal/v1/reviewers" && request.method === "GET") return listEligibleAssignees(request, env);
  if (path === `${BASE}/bootstrap` && request.method === "POST") return bootstrap(request, env);
  if (path === `${BASE}/login` && request.method === "POST") return requestSignIn(request, env);
  if (path === `${BASE}/verify` && request.method === "POST") return verifyChallenge(request, env);
  if (path === `${BASE}/logout` && request.method === "POST") {
    if (!sameOrigin(request)) return fail("origin_invalid", "request origin is invalid", 403);
    const rawToken = cookie(request);
    if (rawToken) await env.CONTROL_DB.prepare("UPDATE internal_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now(), await sha256(rawToken)).run();
    return clearAdminSessionCookie(clearSessionCookie(json({ data: { signed_out: true } })));
  }
  if (path === `${BASE}/me` && request.method === "GET") {
    const user = await resolveInternalUser(request, env);
    return user ? json({ data: user }) : fail("unauthorized", "verified Internals sign-in required", 401);
  }
  if (path === "/api/internal/v1/users") {
    const actor = await ownerRequired(request, env);
    if (actor instanceof Response) return actor;
    if (request.method === "GET") {
      const rows = await env.CONTROL_DB.prepare(`SELECT u.id, u.email, u.display_name, u.status, u.email_verified_at, u.created_at,
          GROUP_CONCAT(r.role) AS roles
        FROM internal_users u LEFT JOIN internal_user_roles r ON r.user_id = u.id
        GROUP BY u.id ORDER BY u.email`)
        .all<{ id: string; email: string; display_name: string; status: string; email_verified_at: string | null; created_at: string; roles: string | null }>();
      return json({ data: rows.results.map((row) => ({ ...row, roles: (row.roles ?? "").split(",").filter(Boolean), email_verified: row.email_verified_at !== null })) });
    }
    if (request.method === "POST") return createUser(request, env);
    return fail("method_not_allowed", "method not allowed", 405);
  }
  const userAction = path.match(/^\/api\/internal\/v1\/users\/([^/]+)(?:\/(resend))?$/);
  if (userAction) {
    if (userAction[2] === "resend") return request.method === "POST" ? resendInvitation(request, env, decodeURIComponent(userAction[1])) : fail("method_not_allowed", "method not allowed", 405);
    return request.method === "PATCH" ? updateUser(request, env, decodeURIComponent(userAction[1])) : fail("method_not_allowed", "method not allowed", 405);
  }
  return null;
}
