/** @type implementation @purpose Restrict and authenticate sampling-runner service-binding calls. */
export interface RunnerControlEnv {
  CONTROL_PLANE: Fetcher;
  RUNNER_TOKEN: string;
}

export async function forwardControlPlane(request: Request, env: RunnerControlEnv): Promise<Response> {
  const source = new URL(request.url);
  if (!source.pathname.startsWith("/api/internal/v1/runner/")) return new Response("runner path is not allowed", { status: 403 });
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("authorization", `Bearer ${env.RUNNER_TOKEN}`);
  const target = new URL(source.pathname + source.search, "https://control-plane.internal");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const operation = ["claim", "heartbeat", "sources", "artifacts", "finalize", "fail"]
    .find((name) => source.pathname.endsWith(`/${name}`))
    ?? (request.method === "PUT" ? "artifact_upload" : "unknown");
  const startedAt = Date.now();
  try {
    const response = await env.CONTROL_PLANE.fetch(new Request(target, { method: request.method, headers, body, redirect: "manual" }));
    console.log({
      event: "sampling_runner_control_plane_response",
      method: request.method,
      operation,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    console.error({
      event: "sampling_runner_control_plane_failed",
      method: request.method,
      operation,
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}
