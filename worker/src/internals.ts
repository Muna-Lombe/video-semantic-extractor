/**
 * D1-backed control-plane routes for the first Internals vertical slice.
 *
 * This module records datasets and durable sampling-job metadata. It does not
 * execute sampling: the existing diagnostic CLI remains the only runner until
 * a queue consumer is introduced.
 */
import type { AdjudicationEnv } from "./types";

type JsonRecord = Record<string, unknown>;
type DatasetStatus = "draft" | "ready" | "active" | "archived";
type SamplingMethod = "scene" | "interval" | "hybrid";

const DATASET_STATUSES = new Set<DatasetStatus>(["draft", "ready", "active", "archived"]);
const SAMPLING_METHODS = new Set<SamplingMethod>(["scene", "interval", "hybrid"]);
const MAX_BODY_BYTES = 64 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function error(code: string, message: string, status: number, details?: JsonRecord): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

function authorized(request: Request, env: AdjudicationEnv): boolean {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") === true && header.slice(7) === env.ADMIN_TOKEN;
}

async function body(request: Request): Promise<JsonRecord | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return error("unsupported_media_type", "content-type must be application/json", 415);
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return error("request_too_large", "request body is too large", 413);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return error("invalid_request", "request body must be a JSON object", 400);
    }
    return value as JsonRecord;
  } catch {
    return error("invalid_json", "request body is not valid JSON", 400);
  }
}

function exactKeys(value: JsonRecord, allowed: readonly string[]): string[] {
  const permitted = new Set(allowed);
  return Object.keys(value).filter((key) => !permitted.has(key));
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function page(url: URL): { limit: number; offset: number } | Response {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  const rawOffset = url.searchParams.get("offset") ?? "0";
  if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) {
    return error("invalid_pagination", "limit and offset must be non-negative integers", 400);
  }
  const limit = Number(rawLimit), offset = Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return error("invalid_pagination", "limit must be between 1 and 100", 400);
  if (!Number.isSafeInteger(offset)) return error("invalid_pagination", "offset is too large", 400);
  return { limit, offset };
}

function datasetRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_count: Number(row.source_count ?? 0),
    ...(row.latest_version_id ? { latest_version: { id: row.latest_version_id, version: Number(row.latest_version_number ?? 1), status: row.latest_version_status } } : {}),
  };
}

function jobRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.job_type,
    status: row.status,
    input: JSON.parse(String(row.input_json)),
    progress: row.progress_json == null ? null : JSON.parse(String(row.progress_json)),
    output: row.output_json == null ? null : JSON.parse(String(row.output_json)),
    error_message: row.error_message,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

async function createDataset(request: Request, env: AdjudicationEnv): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  const unknown = exactKeys(value, ["name", "description", "sources"]);
  if (unknown.length) return error("invalid_request", "request contains unknown fields", 400, { fields: unknown });
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 120) {
    return error("invalid_request", "name must be a non-empty string of at most 120 characters", 400);
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 2000)) {
    return error("invalid_request", "description must be a string of at most 2000 characters", 400);
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 100) {
    return error("invalid_request", "sources must contain between 1 and 100 source objects", 400);
  }
  const sources: Array<{ id: string; url: string; display_name: string | null; ordinal: number }> = [];
  const seen = new Set<string>();
  for (const [ordinal, candidate] of value.sources.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return error("invalid_request", "each source must be an object", 400, { ordinal });
    const source = candidate as JsonRecord, sourceUnknown = exactKeys(source, ["url", "display_name"]);
    if (sourceUnknown.length) return error("invalid_request", "source contains unknown fields", 400, { ordinal, fields: sourceUnknown });
    if (typeof source.url !== "string") return error("invalid_request", "source url is required", 400, { ordinal });
    let parsed: URL;
    try { parsed = new URL(source.url); } catch { return error("invalid_request", "source url must be a valid HTTPS URL", 400, { ordinal }); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return error("invalid_request", "source url must use HTTPS without credentials or a fragment", 400, { ordinal });
    const normalized = parsed.toString();
    if (seen.has(normalized)) return error("invalid_request", "source urls must be unique", 400, { ordinal });
    if (source.display_name !== undefined && (typeof source.display_name !== "string" || source.display_name.trim().length < 1 || source.display_name.trim().length > 200)) return error("invalid_request", "source display_name must contain 1-200 characters", 400, { ordinal });
    seen.add(normalized);
    sources.push({ id: id("src"), url: normalized, display_name: typeof source.display_name === "string" ? source.display_name.trim() : null, ordinal });
  }
  const datasetId = id("ds"), versionId = id("dsv"), now = new Date().toISOString();
  await env.DATASET_DB.batch([
    env.DATASET_DB.prepare("INSERT INTO datasets (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)")
      .bind(datasetId, value.name.trim(), value.description ?? "", now, now),
    env.DATASET_DB.prepare("INSERT INTO dataset_versions (id, dataset_id, version, status, created_at) VALUES (?, ?, 1, 'frozen', ?)")
      .bind(versionId, datasetId, now),
    ...sources.map((source) => env.DATASET_DB.prepare("INSERT INTO dataset_sources (id, dataset_version_id, source_url, display_name, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(source.id, versionId, source.url, source.display_name, source.ordinal, now)),
  ]);
  return json({ data: { id: datasetId, name: value.name.trim(), description: value.description ?? "", status: "ready", source_count: sources.length, created_at: now, updated_at: now, initial_version: { id: versionId, version: 1, status: "frozen", sources } } }, 201);
}

async function listDatasets(url: URL, env: AdjudicationEnv): Promise<Response> {
  const pagination = page(url);
  if (pagination instanceof Response) return pagination;
  const status = url.searchParams.get("status");
  if (status !== null && !DATASET_STATUSES.has(status as DatasetStatus)) return error("invalid_filter", "invalid dataset status", 400);
  const where = status === null ? "" : " WHERE d.status = ?";
  const args: unknown[] = status === null ? [] : [status];
  const rows = await env.DATASET_DB.prepare(`SELECT d.id, d.name, d.description, d.status, d.created_at, d.updated_at,
    (SELECT dv.id FROM dataset_versions dv WHERE dv.dataset_id = d.id ORDER BY dv.version DESC LIMIT 1) AS latest_version_id,
    (SELECT dv.version FROM dataset_versions dv WHERE dv.dataset_id = d.id ORDER BY dv.version DESC LIMIT 1) AS latest_version_number,
    (SELECT dv.status FROM dataset_versions dv WHERE dv.dataset_id = d.id ORDER BY dv.version DESC LIMIT 1) AS latest_version_status,
    (SELECT COUNT(*) FROM dataset_sources ds JOIN dataset_versions dv ON dv.id = ds.dataset_version_id WHERE dv.dataset_id = d.id) AS source_count
    FROM datasets d${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, pagination.limit + 1, pagination.offset).all<Record<string, unknown>>();
  const values = rows.results ?? [], hasMore = values.length > pagination.limit;
  return json({ data: values.slice(0, pagination.limit).map(datasetRow), pagination: { limit: pagination.limit, offset: pagination.offset, has_more: hasMore, next_offset: hasMore ? pagination.offset + pagination.limit : null } });
}

async function getDataset(datasetId: string, env: AdjudicationEnv): Promise<Response> {
  const row = await env.DATASET_DB.prepare("SELECT id, name, description, status, created_at, updated_at, (SELECT COUNT(*) FROM dataset_sources ds JOIN dataset_versions dv ON dv.id = ds.dataset_version_id WHERE dv.dataset_id = datasets.id) AS source_count FROM datasets WHERE id = ?").bind(datasetId).first<Record<string, unknown>>();
  if (!row) return error("not_found", "dataset not found", 404);
  const versions = await env.DATASET_DB.prepare("SELECT id, version, status, manifest_artifact_id, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY version DESC").bind(datasetId).all<Record<string, unknown>>();
  const sources = await env.DATASET_DB.prepare("SELECT ds.id, ds.dataset_version_id, ds.source_url AS url, ds.display_name, ds.ordinal, ds.created_at FROM dataset_sources ds JOIN dataset_versions dv ON dv.id = ds.dataset_version_id WHERE dv.dataset_id = ? ORDER BY dv.version DESC, ds.ordinal").bind(datasetId).all<Record<string, unknown>>();
  return json({ data: { ...datasetRow(row), versions: versions.results ?? [], sources: sources.results ?? [] } });
}

async function createSamplingJob(request: Request, env: AdjudicationEnv): Promise<Response> {
  const value = await body(request);
  if (value instanceof Response) return value;
  const unknown = exactKeys(value, ["dataset_version_id", "method", "scene_threshold", "interval_seconds", "max_frames", "include_final_frame"]);
  if (unknown.length) return error("invalid_request", "request contains unknown fields", 400, { fields: unknown });
  if (typeof value.dataset_version_id !== "string" || !value.dataset_version_id) return error("invalid_request", "dataset_version_id is required", 400);
  if (typeof value.method !== "string" || !SAMPLING_METHODS.has(value.method as SamplingMethod)) return error("invalid_request", "method must be scene, interval, or hybrid", 400);
  const numeric = (key: string, minimum: number) => value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= minimum);
  if (!numeric("scene_threshold", 0) || (typeof value.scene_threshold === "number" && value.scene_threshold > 1)) return error("invalid_request", "scene_threshold must be between 0 and 1", 400);
  if (!numeric("interval_seconds", 0.001)) return error("invalid_request", "interval_seconds must be greater than zero", 400);
  if (value.max_frames !== undefined && (!Number.isInteger(value.max_frames) || Number(value.max_frames) < 1)) return error("invalid_request", "max_frames must be a positive integer", 400);
  if (value.include_final_frame !== undefined && typeof value.include_final_frame !== "boolean") return error("invalid_request", "include_final_frame must be a boolean", 400);
  if ((value.method === "scene" || value.method === "hybrid") && value.scene_threshold === undefined) return error("invalid_request", "scene_threshold is required for scene and hybrid sampling", 400);
  if ((value.method === "interval" || value.method === "hybrid") && value.interval_seconds === undefined) return error("invalid_request", "interval_seconds is required for interval and hybrid sampling", 400);

  const version = await env.DATASET_DB.prepare("SELECT id, status FROM dataset_versions WHERE id = ?").bind(value.dataset_version_id).first<{ id: string; status: string }>();
  if (!version) return error("not_found", "dataset version not found", 404);
  if (version.status !== "frozen" && version.status !== "ready") return error("invalid_state", "only ready or frozen dataset versions can be sampled", 409);
  const input = { dataset_version_id: value.dataset_version_id, method: value.method, ...(value.scene_threshold === undefined ? {} : { scene_threshold: value.scene_threshold }), ...(value.interval_seconds === undefined ? {} : { interval_seconds: value.interval_seconds }), ...(value.max_frames === undefined ? {} : { max_frames: value.max_frames }), include_final_frame: value.include_final_frame ?? true };
  const jobId = id("job"), now = new Date().toISOString();
  await env.CONTROL_DB.prepare("INSERT INTO internal_jobs (id, job_type, status, input_json, created_at, updated_at) VALUES (?, 'sampling', 'queued', ?, ?, ?)").bind(jobId, JSON.stringify(input), now, now).run();
  return json({ data: { id: jobId, type: "sampling", status: "queued", input, progress: null, output: null, error_message: null, created_at: now, started_at: null, completed_at: null, updated_at: now }, meta: { execution_scheduled: false, runner: "legacy_cli" } }, 202);
}

async function listSamplingJobs(url: URL, env: AdjudicationEnv): Promise<Response> {
  const pagination = page(url);
  if (pagination instanceof Response) return pagination;
  const rows = await env.CONTROL_DB.prepare("SELECT * FROM internal_jobs WHERE job_type = 'sampling' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").bind(pagination.limit + 1, pagination.offset).all<Record<string, unknown>>();
  const values = rows.results ?? [], hasMore = values.length > pagination.limit;
  return json({ data: values.slice(0, pagination.limit).map(jobRow), pagination: { limit: pagination.limit, offset: pagination.offset, has_more: hasMore, next_offset: hasMore ? pagination.offset + pagination.limit : null } });
}

async function getSamplingJob(jobId: string, env: AdjudicationEnv): Promise<Response> {
  const row = await env.CONTROL_DB.prepare("SELECT * FROM internal_jobs WHERE id = ? AND job_type = 'sampling'").bind(jobId).first<Record<string, unknown>>();
  return row ? json({ data: jobRow(row) }) : error("not_found", "sampling job not found", 404);
}

/** Return null when the path is not owned by this module. */
export async function handleInternalsApi(request: Request, env: AdjudicationEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/internal/v1/")) return null;
  if (!authorized(request, env)) return error("unauthorized", "administrator bearer token required", 401);
  if (path === "/api/internal/v1/datasets") {
    if (request.method === "POST") return createDataset(request, env);
    if (request.method === "GET") return listDatasets(url, env);
    return error("method_not_allowed", "method not allowed", 405);
  }
  const datasetMatch = path.match(/^\/api\/internal\/v1\/datasets\/([^/]+)$/);
  if (datasetMatch) return request.method === "GET" ? getDataset(decodeURIComponent(datasetMatch[1]), env) : error("method_not_allowed", "method not allowed", 405);
  if (path === "/api/internal/v1/sampling-jobs") {
    if (request.method === "POST") return createSamplingJob(request, env);
    if (request.method === "GET") return listSamplingJobs(url, env);
    return error("method_not_allowed", "method not allowed", 405);
  }
  const jobMatch = path.match(/^\/api\/internal\/v1\/sampling-jobs\/([^/]+)$/);
  if (jobMatch) return request.method === "GET" ? getSamplingJob(decodeURIComponent(jobMatch[1]), env) : error("method_not_allowed", "method not allowed", 405);
  return null;
}
