/** @type implementation @purpose Track pipeline lineage and derive progress from linked resources. */
import type { AdjudicationEnv } from "./types";
import { canAccessInternals, resolveInternalActor, type InternalActor } from "./internal-auth";

type ResourceType = "dataset" | "dataset_version" | "sampling_job" | "frame_set" | "template" | "review_campaign" | "evaluation_run" | "model_version" | "pipeline_release";
type JsonRecord = Record<string, unknown>;
const RESOURCE_TYPES = new Set<ResourceType>(["dataset", "dataset_version", "sampling_job", "frame_set", "template", "review_campaign", "evaluation_run", "model_version", "pipeline_release"]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PIPELINE_RESOURCES = 100;
const now = () => new Date().toISOString();
const id = () => `pipeline_${crypto.randomUUID().replaceAll("-", "")}`;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

class PipelineError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function fail(message: string, status = 400): never {
  throw new PipelineError(message, status);
}

async function body(request: Request): Promise<JsonRecord> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("content-type must be application/json", 415);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) fail("request body is too large", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) fail("request body is too large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("request body must be a JSON object");
  return value as JsonRecord;
}

function pagination(url: URL): { limit: number; offset: number } {
  const limitText = url.searchParams.get("limit") ?? "50";
  const offsetText = url.searchParams.get("offset") ?? "0";
  if (!/^\d+$/.test(limitText) || !/^\d+$/.test(offsetText)) fail("limit and offset must be non-negative integers");
  const limit = Number(limitText), offset = Number(offsetText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset)) fail("limit must be 1-100 and offset must be a non-negative safe integer");
  return { limit, offset };
}

async function resourceStatus(type: ResourceType, resourceId: string, env: AdjudicationEnv): Promise<{ status: string; label?: string; [key: string]: unknown } | null> {
  let row: { status: string; label?: string; [key: string]: unknown } | null = null;
  switch (type) {
    case "dataset":
      row = await env.DATASET_DB.prepare("SELECT status, name AS label FROM datasets WHERE id = ?").bind(resourceId).first();
      break;
    case "dataset_version":
      row = await env.DATASET_DB.prepare("SELECT status, id AS label FROM dataset_versions WHERE id = ?").bind(resourceId).first();
      break;
    case "sampling_job":
      row = await env.CONTROL_DB.prepare("SELECT status, id AS label FROM internal_jobs WHERE id = ? AND job_type = 'sampling'").bind(resourceId).first();
      break;
    case "frame_set":
      row = await env.CONTROL_DB.prepare("SELECT status, id AS label, dataset_version_id, sampling_job_id FROM frame_sets WHERE id = ?").bind(resourceId).first();
      break;
    case "template":
      row = await env.CONTROL_DB.prepare("SELECT status, id AS label, frame_set_id FROM templates WHERE id = ?").bind(resourceId).first();
      break;
    case "review_campaign":
      row = await env.CONTROL_DB.prepare("SELECT status, name AS label, template_id FROM review_campaigns WHERE id = ?").bind(resourceId).first();
      break;
    case "evaluation_run":
      row = await env.CONTROL_DB.prepare(`SELECT j.status, r.id AS label, r.ground_truth_version_id, r.model_version_id, r.pipeline_release_id,
        c.id AS review_campaign_id, t.id AS template_id, fs.id AS frame_set_id, fs.dataset_version_id, fs.sampling_job_id
        FROM evaluation_runs r JOIN internal_jobs j ON j.id = r.job_id
        LEFT JOIN ground_truth_versions gt ON gt.id = r.ground_truth_version_id
        LEFT JOIN review_campaigns c ON c.id = gt.campaign_id
        LEFT JOIN templates t ON t.id = c.template_id
        LEFT JOIN frame_sets fs ON fs.id = t.frame_set_id
        WHERE r.id = ?`).bind(resourceId).first();
      break;
    case "model_version":
      row = await env.CONTROL_DB.prepare("SELECT status, id AS label, model_id FROM model_versions WHERE id = ?").bind(resourceId).first();
      break;
    case "pipeline_release":
      row = await env.CONTROL_DB.prepare("SELECT status, id AS label FROM pipeline_releases WHERE id = ?").bind(resourceId).first();
      break;
  }
  if (!row) return null;
  const lineage = Object.fromEntries(Object.entries(row)
    .filter(([key, value]) => key.endsWith("_id") && typeof value === "string")
    .map(([key, value]) => [key, value as string]));
  return { status: String(row.status), label: String(row.label ?? resourceId), ...(Object.keys(lineage).length ? { lineage } : {}) };
}

function progressClass(type: ResourceType, status: string): "complete" | "active" | "attention" {
  if (["failed", "cancelled", "invalid", "rejected", "rolled_back"].includes(status)) return "attention";
  if (type === "dataset" || type === "dataset_version") return ["ready", "active", "frozen", "archived"].includes(status) ? "complete" : "active";
  if (type === "sampling_job" || type === "evaluation_run") return status === "succeeded" ? "complete" : ["queued", "running"].includes(status) ? "active" : "attention";
  if (type === "frame_set") return ["ready", "archived"].includes(status) ? "complete" : "attention";
  if (type === "template") return ["ready", "superseded", "archived"].includes(status) ? "complete" : status === "generating" ? "active" : "attention";
  if (type === "review_campaign") return status === "completed" ? "complete" : "active";
  if (type === "model_version") return ["approved", "production"].includes(status) ? "complete" : ["rejected", "retired"].includes(status) ? "attention" : "active";
  return ["approved", "active", "superseded"].includes(status) ? "complete" : "active";
}

async function pipelineDetail(pipeline: Record<string, unknown>, env: AdjudicationEnv) {
  const links = await env.CONTROL_DB.prepare("SELECT resource_type, resource_id, ordinal, created_at FROM pipeline_resources WHERE pipeline_id = ? ORDER BY ordinal, created_at, resource_type, resource_id")
    .bind(pipeline.id).all<{ resource_type: ResourceType; resource_id: string; ordinal: number; created_at: string }>();
  const resources = [];
  for (const link of links.results ?? []) {
    const resource = await resourceStatus(link.resource_type, link.resource_id, env);
    resources.push({
      ...link,
      label: resource?.label ?? link.resource_id,
      status: resource?.status ?? "missing",
      progress: resource ? progressClass(link.resource_type, resource.status) : "attention",
      lineage: resource?.lineage ?? {},
    });
  }
  const completedCount = resources.filter((resource) => resource.progress === "complete").length;
  const attentionCount = resources.filter((resource) => resource.progress === "attention").length;
  const progressStatus = resources.length === 0 ? "not_started"
    : attentionCount > 0 ? "attention"
      : completedCount === resources.length ? "complete" : "in_progress";
  return {
    ...pipeline,
    resources,
    progress: {
      status: progressStatus,
      completed_count: completedCount,
      total_count: resources.length,
      percentage: resources.length ? Math.round(completedCount * 100 / resources.length) : 0,
    },
  };
}

async function validateResource(type: ResourceType, resourceId: string, env: AdjudicationEnv): Promise<void> {
  const resource = await resourceStatus(type, resourceId, env);
  if (!resource) fail(`${type.replaceAll("_", " ")} not found`, 404);
}

async function createPipeline(request: Request, env: AdjudicationEnv, actor: InternalActor): Promise<Response> {
  const value = await body(request);
  if (Object.keys(value).some((key) => !["name", "description", "resources"].includes(key))) fail("request contains unknown fields");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 120) fail("name must contain 1-120 characters");
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 2000)) fail("description must be at most 2000 characters");
  if (value.resources !== undefined && (!Array.isArray(value.resources) || value.resources.length > MAX_PIPELINE_RESOURCES)) fail(`resources must be an array of at most ${MAX_PIPELINE_RESOURCES} links`);
  const resources = (value.resources ?? []) as unknown[];
  if (resources.some((resource) => !resource || typeof resource !== "object" || Array.isArray(resource) || Object.keys(resource).some((key) => !["resource_type", "resource_id"].includes(key)))) fail("each resource must contain only resource_type and resource_id");
  const seen = new Set<string>();
  for (const resource of resources as JsonRecord[]) {
    const key = `${String(resource.resource_type)}\0${String(resource.resource_id)}`;
    if (seen.has(key)) fail("pipeline resource links must be unique");
    seen.add(key);
    if (typeof resource.resource_type !== "string" || !RESOURCE_TYPES.has(resource.resource_type as ResourceType)) fail("resource_type is not supported");
    if (typeof resource.resource_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(resource.resource_id)) fail("resource_id must contain 1-128 safe characters");
    await validateResource(resource.resource_type as ResourceType, resource.resource_id, env);
  }
  const timestamp = now(), pipelineId = id();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("INSERT INTO pipelines (id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(pipelineId, value.name.trim(), value.description ?? "", actor.kind === "user" ? actor.user.id : null, timestamp, timestamp),
    ...(resources as JsonRecord[]).map((resource, ordinal) => env.CONTROL_DB.prepare("INSERT INTO pipeline_resources (pipeline_id, resource_type, resource_id, ordinal, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(pipelineId, resource.resource_type, resource.resource_id, ordinal, timestamp)),
    env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'pipeline.created', 'pipeline', ?, ?, ?)")
      .bind(actor.kind === "user" ? actor.user.id : null, pipelineId, JSON.stringify({ resource_count: resources.length }), timestamp),
  ]);
  const pipeline = await env.CONTROL_DB.prepare("SELECT * FROM pipelines WHERE id = ?").bind(pipelineId).first<Record<string, unknown>>();
  if (!pipeline) throw new Error("pipeline creation did not persist");
  return json({ data: await pipelineDetail(pipeline, env) }, 201);
}

export async function handlePipelineTracking(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/internal/v1/pipelines")) return null;
  try {
    const actor = await resolveInternalActor(request, env);
    if (!actor) fail("verified Internals sign-in required", 401);
    if (!canAccessInternals(actor, request)) fail("your role is not allowed to perform this operation", 403);
    if (path === "/api/internal/v1/pipelines") {
      if (request.method === "POST") return await createPipeline(request, env, actor);
      if (request.method !== "GET") fail("method not allowed", 405);
      const { limit, offset } = pagination(new URL(request.url));
      const rows = await env.CONTROL_DB.prepare("SELECT * FROM pipelines ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").bind(limit + 1, offset).all<Record<string, unknown>>();
      const values = rows.results ?? [], hasMore = values.length > limit;
      const data = [];
      for (const pipeline of values.slice(0, limit)) data.push(await pipelineDetail(pipeline, env));
      return json({ data, pagination: { limit, offset, has_more: hasMore, next_offset: hasMore ? offset + limit : null } });
    }
    const match = path.match(/^\/api\/internal\/v1\/pipelines\/([^/]+)(?:\/resources(?:\/([^/]+)\/([^/]+))?)?$/);
    if (!match) fail("not found", 404);
    const pipelineId = decodeURIComponent(match[1]);
    const pipeline = await env.CONTROL_DB.prepare("SELECT * FROM pipelines WHERE id = ?").bind(pipelineId).first<Record<string, unknown>>();
    if (!pipeline) fail("pipeline not found", 404);
    if (match[2] && match[3]) {
      if (request.method !== "DELETE") fail("method not allowed", 405);
      const resourceType = decodeURIComponent(match[2]), resourceId = decodeURIComponent(match[3]);
      if (!RESOURCE_TYPES.has(resourceType as ResourceType)) fail("resource_type is not supported");
      const linked = await env.CONTROL_DB.prepare("SELECT 1 AS present FROM pipeline_resources WHERE pipeline_id = ? AND resource_type = ? AND resource_id = ?")
        .bind(pipelineId, resourceType, resourceId).first<{ present: number }>();
      if (!linked) fail("pipeline resource link not found", 404);
      const timestamp = now();
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare("DELETE FROM pipeline_resources WHERE pipeline_id = ? AND resource_type = ? AND resource_id = ?")
          .bind(pipelineId, resourceType, resourceId),
        env.CONTROL_DB.prepare("UPDATE pipelines SET updated_at = ? WHERE id = ?").bind(timestamp, pipelineId),
        env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'pipeline.resource_unlinked', 'pipeline', ?, ?, ?)")
          .bind(actor.kind === "user" ? actor.user.id : null, pipelineId, JSON.stringify({ resource_type: resourceType, resource_id: resourceId }), timestamp),
      ]);
      const updated = await env.CONTROL_DB.prepare("SELECT * FROM pipelines WHERE id = ?").bind(pipelineId).first<Record<string, unknown>>();
      if (!updated) throw new Error("pipeline disappeared after unlink");
      return json({ data: await pipelineDetail(updated, env) });
    }
    if (path.endsWith("/resources")) {
      if (request.method !== "POST") fail("method not allowed", 405);
      const value = await body(request);
      if (Object.keys(value).some((key) => !["resource_type", "resource_id"].includes(key))) fail("request contains unknown fields");
      if (typeof value.resource_type !== "string" || !RESOURCE_TYPES.has(value.resource_type as ResourceType)) fail("resource_type is not supported");
      if (typeof value.resource_id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.resource_id)) fail("resource_id must contain 1-128 safe characters");
      const resourceType = value.resource_type as ResourceType, resourceId = value.resource_id;
      await validateResource(resourceType, resourceId, env);
      const count = await env.CONTROL_DB.prepare("SELECT COUNT(*) AS count FROM pipeline_resources WHERE pipeline_id = ?").bind(pipelineId).first<{ count: number }>();
      if (Number(count?.count ?? 0) >= MAX_PIPELINE_RESOURCES) fail(`a pipeline can have at most ${MAX_PIPELINE_RESOURCES} linked resources`, 409);
      const existing = await env.CONTROL_DB.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM pipeline_resources WHERE pipeline_id = ?").bind(pipelineId).first<{ ordinal: number }>();
      const timestamp = now();
      await env.CONTROL_DB.batch([
        env.CONTROL_DB.prepare("INSERT INTO pipeline_resources (pipeline_id, resource_type, resource_id, ordinal, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(pipelineId, resourceType, resourceId, Number(existing?.ordinal ?? 0), timestamp),
        env.CONTROL_DB.prepare("UPDATE pipelines SET updated_at = ? WHERE id = ?").bind(timestamp, pipelineId),
        env.CONTROL_DB.prepare("INSERT INTO internal_audit_events (actor_user_id, action, resource_type, resource_id, details_json, created_at) VALUES (?, 'pipeline.resource_linked', 'pipeline', ?, ?, ?)")
          .bind(actor.kind === "user" ? actor.user.id : null, pipelineId, JSON.stringify({ resource_type: resourceType, resource_id: resourceId }), timestamp),
      ]);
      const updated = await env.CONTROL_DB.prepare("SELECT * FROM pipelines WHERE id = ?").bind(pipelineId).first<Record<string, unknown>>();
      if (!updated) throw new Error("pipeline disappeared after link");
      return json({ data: await pipelineDetail(updated, env) }, 201);
    }
    if (request.method !== "GET") fail("method not allowed", 405);
    return json({ data: await pipelineDetail(pipeline, env) });
  } catch (cause) {
    if (cause instanceof PipelineError) return json({ error: { code: cause.status === 404 ? "not_found" : "invalid_request", message: cause.message } }, cause.status);
    if (cause instanceof Error && cause.message.includes("pipeline_resource_limit")) return json({ error: { code: "resource_limit", message: `a pipeline can have at most ${MAX_PIPELINE_RESOURCES} linked resources` } }, 409);
    if (cause instanceof Error && /UNIQUE constraint failed: pipeline_resources/.test(cause.message)) return json({ error: { code: "duplicate_resource", message: "resource is already linked to this pipeline" } }, 409);
    throw cause;
  }
}
