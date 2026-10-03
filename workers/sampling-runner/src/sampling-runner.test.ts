/** @type test @purpose Verify the sampling-runner Worker keeps execution private. */
import { describe, expect, it, vi } from "vitest";
import { forwardControlPlane } from "./sampling-runner-control";

describe("sampling runner worker", () => {
  it("allowlists runner paths and injects service authentication", async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ authorization: request.headers.get("authorization"), path: new URL(request.url).pathname }));
    const accepted = await forwardControlPlane(new Request("http://control.internal/api/internal/v1/runner/sampling-jobs/claim", { method: "POST", body: "{}" }), { CONTROL_PLANE: { fetch } as unknown as Fetcher, RUNNER_TOKEN: "secret" });
    expect(await accepted.json()).toEqual({ authorization: "Bearer secret", path: "/api/internal/v1/runner/sampling-jobs/claim" });
    expect((await forwardControlPlane(new Request("http://control.internal/api/v1/admin/reviews"), {} as any)).status).toBe(403);
  });
});
