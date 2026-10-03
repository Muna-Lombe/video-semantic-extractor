/** @type test @purpose Verify hosted review assignment isolation, discovery, adjudication, and private results. */
import { describe, expect, it } from "vitest";
import worker from "./adjudication";
import type { AdjudicationEnv } from "./types";

class MemoryBucket {
  values = new Map<string, string>();
  async get(key: string) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return { body: new Response(value).body, json: async <T>() => JSON.parse(value) as T };
  }
  async put(key: string, value: string | ReadableStream | ArrayBuffer) {
    this.values.set(key, typeof value === "string" ? value : await new Response(value).text());
  }
  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return { objects: [...this.values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
  }
}

function template() {
  return {
    policy_version: "2026-09-18",
    review: { independent_passes: 0, adjudication_status: "not_started", reviewed_frames: [] },
    sources: [{ source: "sample.mp4", source_sha256: "a".repeat(64), frames: [{ filename: "frame.jpg", timestamp_sec: 1, objects: [], out_of_taxonomy: [] }] }],
  };
}
function submission(label: string) {
  const value: any = template();
  value.review.reviewed_frames = ["sample.mp4/frame.jpg"];
  value.sources[0].frames[0].objects = [{ id: `${label}-1`, label, subset: "live", region: [1, 2, 20, 30] }];
  return value;
}
function request(path: string, method = "GET", body?: unknown, token?: string) {
  return new Request(`https://review.test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
function environment(bucket = new MemoryBucket()): AdjudicationEnv {
  return {
    REVIEW_BUCKET: bucket as unknown as R2Bucket,
    INTERNAL_ARTIFACTS_BUCKET: {} as R2Bucket,
    CONTROL_DB: {} as D1Database,
    DATASET_DB: {} as D1Database,
    ADMIN_TOKEN: "admin-secret",
    ASSETS: { fetch: async (request: Request) => new Response(new URL(request.url).pathname.startsWith("/internals/") ? "<h1>Internals workspace</h1>" : "<h1>Secure annotation workspace</h1>", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher,
  };
}
async function create(env: AdjudicationEnv, id = "review-1") {
  const response = await worker.fetch(request("/api/v1/admin/reviews", "POST", { id, template: template(), frame_urls: { "sample.mp4/frame.jpg": "https://evidence.example/frame.jpg" } }, "admin-secret"), env);
  expect(response.status).toBe(201);
  return await response.json() as any;
}

describe("hosted review worker", () => {
  it("serves an honest Internals foundation while protecting its overview API", async () => {
    const env = environment();
    const page = await worker.fetch(request("/internals/"), env);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    const markup = await page.text();
    expect(markup).toContain("Internals workspace");

    expect((await worker.fetch(request("/api/internal/v1/overview"), env)).status).toBe(401);
    const assignmentEnv = environment();
    const created = await create(assignmentEnv, "internal-auth");
    expect((await worker.fetch(request("/api/internal/v1/overview", "GET", undefined, created.invitations["reviewer-a"].api_token), assignmentEnv)).status).toBe(403);

    const response = await worker.fetch(request("/api/internal/v1/overview", "GET", undefined, "admin-secret"), env);
    expect(response.status).toBe(200);
    const overview = await response.json() as any;
    expect(overview.maturity).toBe("foundation");
    expect(overview.control_plane).toEqual(expect.objectContaining({ binding: "CONTROL_DB", engine: "D1" }));
    expect(overview.invitation_experiences).toEqual(expect.objectContaining({ review: "/review/", adjudication: "/adjudicate/" }));
    expect(overview.areas).toContainEqual(expect.objectContaining({ id: "reviews", status: "available" }));
    expect(overview.areas).toContainEqual(expect.objectContaining({ id: "datasets", status: "available" }));
    expect(overview.areas).toContainEqual(expect.objectContaining({ id: "sampling", status: "artifact_protocol" }));
    expect(overview.areas).toContainEqual(expect.objectContaining({ id: "frame-sets", status: "available" }));
  });

  it("publishes safe API discovery without listing active work", async () => {
    const env = environment();
    const response = await worker.fetch(request("/list"), env);
    expect(response.status).toBe(200);
    const catalog = await response.json() as any;
    expect(catalog.openapi).toBe("https://review.test/openapi.json");
    expect(catalog.endpoints).toContainEqual(expect.objectContaining({ path: "/api/v1/me", auth: "assignment" }));
    expect(JSON.stringify(catalog)).not.toContain("review-1");
    const specification = await worker.fetch(request("/openapi.json"), env);
    expect(specification.status).toBe(200);
    const openapi = await specification.json() as any;
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.paths).toHaveProperty("/api/internal/v1/overview");
    expect(openapi.paths).toHaveProperty("/api/internal/v1/datasets");
    expect(openapi.paths).toHaveProperty("/api/internal/v1/sampling-jobs");
    expect(openapi.paths).toHaveProperty("/api/internal/v1/runner/sampling-jobs/claim");
  });

  it("creates unique invitation URLs and never returns their secrets from the admin list", async () => {
    const env = environment();
    const created = await create(env);
    const invitations = created.invitations;
    expect(new Set(Object.values(invitations).map((value: any) => value.api_token)).size).toBe(3);
    expect(invitations["reviewer-a"].url).toContain("/review/#token=");
    expect(invitations.adjudicator.url).toContain("/adjudicate/#token=");
    const listed = await worker.fetch(request("/api/v1/admin/reviews", "GET", undefined, "admin-secret"), env);
    const listText = await listed.text();
    expect(listText).toContain("review-1");
    expect(listText).not.toContain(invitations["reviewer-a"].api_token);
    expect(listText).not.toContain("token_hash");
    const revoked = await worker.fetch(request("/api/v1/admin/reviews/review-1/assignments/reviewer-a/revoke", "POST", {}, "admin-secret"), env);
    expect(revoked.status).toBe(200);
    const denied = await worker.fetch(request("/api/v1/me", "GET", undefined, invitations["reviewer-a"].api_token), env);
    expect(denied.status).toBe(401);
  });

  it("isolates reviewer assignments and completes the three-person workflow", async () => {
    const bucket = new MemoryBucket(), env = environment(bucket), created = await create(env);
    const reviewerA = created.invitations["reviewer-a"], reviewerB = created.invitations["reviewer-b"], adjudicator = created.invitations.adjudicator;

    let response = await worker.fetch(request(`/api/v1/assignments/${reviewerB.assignment_id}`, "GET", undefined, reviewerA.api_token), env);
    expect(response.status).toBe(403);
    response = await worker.fetch(request(`/api/v1/adjudications/${adjudicator.assignment_id}`, "GET", undefined, adjudicator.api_token), env);
    expect(response.status).toBe(409);

    for (const [invitation, payload] of [[reviewerA, submission("person")], [reviewerB, submission("chair")]] as const) {
      response = await worker.fetch(request(`/api/v1/assignments/${invitation.assignment_id}`, "PUT", payload, invitation.api_token), env);
      expect(response.status).toBe(200);
      response = await worker.fetch(request(`/api/v1/assignments/${invitation.assignment_id}/complete`, "POST", {}, invitation.api_token), env);
      expect(response.status).toBe(200);
    }

    response = await worker.fetch(request(`/api/v1/adjudications/${adjudicator.assignment_id}`, "GET", undefined, adjudicator.api_token), env);
    expect(response.status).toBe(200);
    const state = await response.json() as any;
    expect(state.comparison.agree).toBe(false);
    response = await worker.fetch(request(`/api/v1/adjudications/${adjudicator.assignment_id}/complete`, "POST", {}, adjudicator.api_token), env);
    expect(response.status).toBe(400);
    response = await worker.fetch(request(`/api/v1/adjudications/${adjudicator.assignment_id}/frames/sample.mp4/frame.jpg`, "PUT", { frame: submission("person").sources[0].frames[0], resolution: "reviewer_a" }, adjudicator.api_token), env);
    expect(response.status).toBe(200);
    response = await worker.fetch(request(`/api/v1/adjudications/${adjudicator.assignment_id}/complete`, "POST", {}, adjudicator.api_token), env);
    expect(response.status).toBe(200);

    response = await worker.fetch(request("/api/v1/reviews/review-1/result", "GET", undefined, reviewerA.api_token), env);
    expect(response.status).toBe(403);
    response = await worker.fetch(request("/api/v1/reviews/review-1/result", "GET", undefined, adjudicator.api_token), env);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.review.adjudication_status).toBe("complete");
    expect(result.review.independent_passes).toBe(2);
    expect(bucket.values.has("results/review-1.json")).toBe(true);
  });

  it("rejects incomplete frame coverage and non-HTTPS or incomplete evidence maps", async () => {
    const env = environment();
    let response = await worker.fetch(request("/api/v1/admin/reviews", "POST", { id: "bad", template: template(), frame_urls: {} }, "admin-secret"), env);
    expect(response.status).toBe(400);
    const created = await create(env, "coverage");
    const reviewer = created.invitations["reviewer-a"], payload = template();
    response = await worker.fetch(request(`/api/v1/assignments/${reviewer.assignment_id}`, "PUT", payload, reviewer.api_token), env);
    expect(response.status).toBe(200);
    response = await worker.fetch(request(`/api/v1/assignments/${reviewer.assignment_id}/complete`, "POST", {}, reviewer.api_token), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "every manifest frame must be reviewed exactly once before completion" });
  });
});
