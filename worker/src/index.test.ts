/** @type test @purpose Verify Worker routing and request validation. */
import { describe, expect, it } from "vitest";
import worker from "./index";
import type { Env } from "./types";

const env: Env = { UPSTREAM_API_URL: "https://api.example.test/capsule" };

describe("capsule worker", () => {
  it("reports health", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects malformed capsule URLs", async () => {
    const request = new Request("https://worker.test/capsule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video_url: "file:///etc/passwd" }),
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it("rejects non-JSON bodies", async () => {
    const request = new Request("https://worker.test/capsule", { method: "POST", body: "video" });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(415);
  });
});
