/**
 * @type implementation
 * @purpose Validate and forward VideoCapsule requests to the Python backend.
 * @dependencies ./types.ts
 */
import type { CapsuleRequest, Env } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_REQUEST_BYTES = 2_048;

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isCapsuleRequest(value: unknown): value is CapsuleRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "video_url")) return false;
  if (typeof record.video_url !== "string" || record.video_url.length > 2_048) return false;
  try {
    const url = new URL(record.video_url);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleCapsule(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "content-type must be application/json" }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "request body is too large" }, 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "request body is too large" }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "request body must be valid JSON" }, 400);
  }
  if (!isCapsuleRequest(body)) {
    return jsonResponse({ error: "video_url must be an absolute HTTP(S) URL" }, 400);
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-request-id", request.headers.get("cf-ray") ?? crypto.randomUUID());
  if (env.CAPSULE_API_TOKEN) headers.set("authorization", `Bearer ${env.CAPSULE_API_TOKEN}`);
  try {
    const upstream = await fetch(env.UPSTREAM_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: { ...JSON_HEADERS, "cache-control": "no-store" },
    });
  } catch {
    return jsonResponse({ error: "capsule service is unavailable" }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ status: "ok" });
    }
    if (url.pathname === "/capsule" && request.method === "POST") {
      return handleCapsule(request, env);
    }
    if (url.pathname === "/capsule") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    return jsonResponse({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
