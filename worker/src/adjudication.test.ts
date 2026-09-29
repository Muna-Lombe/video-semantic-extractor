/** @type test @purpose Verify Worker-hosted adjudication, persistence, and result access. */
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
}

function review(label: string) {
  return {
    policy_version: "2026-09-18",
    review: { independent_passes: 1, adjudication_status: "not_started", manual_pass: { status: "complete" } },
    sources: [{ source: "sample.mp4", source_sha256: "a".repeat(64), frames: [{ filename: "frame.jpg", timestamp_sec: 1, objects: [{ id: 1, label, subset: "live", region: [1, 2, 20, 30] }], out_of_taxonomy: [] }] }],
  };
}

function request(path: string, method = "GET", body?: unknown, token = "secret") {
  return new Request(`https://review.test${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

describe("adjudication worker", () => {
  it("serves its UI without authentication", async () => {
    const env = { REVIEW_BUCKET: new MemoryBucket() as unknown as R2Bucket, ADJUDICATION_TOKEN: "secret" };
    const response = await worker.fetch(request("/", "GET", undefined, "wrong"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Adjudicator C");
  });

  it("creates, resolves, completes, and exposes a result through GET", async () => {
    const bucket = new MemoryBucket();
    const env: AdjudicationEnv = { REVIEW_BUCKET: bucket as unknown as R2Bucket, ADJUDICATION_TOKEN: "secret" };
    const reviewerA = review("person"), reviewerB = review("chair");
    let response = await worker.fetch(request("/api/reviews", "POST", { id: "review-1", reviewer_a: reviewerA, reviewer_b: reviewerB, frame_urls: { "sample.mp4/frame.jpg": "https://evidence.example/frame.jpg" } }), env);
    expect(response.status).toBe(201);
    response = await worker.fetch(request("/api/reviews/review-1/complete", "POST", {}), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "resolve every disagreement frame before completion" });
    response = await worker.fetch(request("/api/reviews/review-1/resolve", "POST", { source: "sample.mp4", filename: "frame.jpg", frame: reviewerA.sources[0].frames[0], resolution: "reviewer_a" }), env);
    expect(response.status).toBe(200);
    response = await worker.fetch(request("/api/reviews/review-1/complete", "POST", {}), env);
    expect(response.status).toBe(200);
    response = await worker.fetch(new Request("https://review.test/results/review-1.json"), env);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.review.adjudication_status).toBe("complete");
    expect(result.review.independent_passes).toBe(2);
    expect(result.sources[0].frames[0].objects[0].label).toBe("person");
    expect(bucket.values.has("results/review-1.json")).toBe(true);
  });

  it("protects mutable review routes", async () => {
    const env = { REVIEW_BUCKET: new MemoryBucket() as unknown as R2Bucket, ADJUDICATION_TOKEN: "secret" };
    const response = await worker.fetch(request("/api/reviews/missing/state", "GET", undefined, "wrong"), env);
    expect(response.status).toBe(401);
  });

  it("rejects incomplete reviewer input", async () => {
    const env = { REVIEW_BUCKET: new MemoryBucket() as unknown as R2Bucket, ADJUDICATION_TOKEN: "secret" };
    const incomplete = review("person"); incomplete.review.manual_pass.status = "in_progress";
    const response = await worker.fetch(request("/api/reviews", "POST", { id: "review-2", reviewer_a: incomplete, reviewer_b: review("chair") }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Reviewer A manual pass is not complete" });
  });
});
