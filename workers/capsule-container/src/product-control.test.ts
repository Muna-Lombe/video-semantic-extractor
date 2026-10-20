/** @type test @purpose Keep service credentials out of the Product Container and restrict its authority. */
import { describe, expect, it } from "vitest";
import { forwardProductControl } from "./product-control";

describe("Product control-plane binding", () => {
  it("injects its own credential for allowed release inputs", async () => {
    let forwarded: Request | undefined;
    const env = { CAPSULE_CONTROL_TOKEN: "worker-only-secret", CONTROL_PLANE: { fetch: async (request: Request) => { forwarded = request; return Response.json({ data: {} }); } } as Fetcher };
    const response = await forwardProductControl(new Request("http://product-control.internal/api/internal/v1/releases/active/execution", { headers: { authorization: "Bearer caller-controlled", cookie: "unrelated-session" } }), env);
    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("authorization")).toBe("Bearer worker-only-secret");
    expect(forwarded?.headers.has("cookie")).toBe(false);
    expect(forwarded?.redirect).toBe("manual");
  });
  it.each(["/api/internal/v1/ground-truth", "/api/internal/v1/releases/active/activate", "/api/internal/v1/models/mv_bad/artifact", "/api/internal/v1/releases/active/execution?token=unexpected"])("rejects %s before invoking a binding", async (path) => {
    expect((await forwardProductControl(new Request("http://product-control.internal" + path), {})).status).toBe(403);
  });
  it("rejects writes and missing service configuration", async () => {
    const path = "http://product-control.internal/api/internal/v1/releases/active/execution";
    expect((await forwardProductControl(new Request(path, { method: "POST" }), {})).status).toBe(403);
    expect((await forwardProductControl(new Request(path), {})).status).toBe(503);
  });
});
