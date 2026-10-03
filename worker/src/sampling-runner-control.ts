/** @type implementation @purpose Restrict and authenticate sampling-runner service-binding calls. */
export interface RunnerControlEnv {
  CONTROL_PLANE: Fetcher;
  RUNNER_TOKEN: string;
}

export async function forwardControlPlane(request: Request, env: RunnerControlEnv): Promise<Response> {
  const source = new URL(request.url);
  if (!source.pathname.startsWith("/api/internal/v1/runner/")) return new Response("runner path is not allowed", { status: 403 });
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.RUNNER_TOKEN}`);
  const target = new URL(source.pathname + source.search, "https://control-plane.internal");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return env.CONTROL_PLANE.fetch(new Request(target, { method: request.method, headers, body, redirect: "manual" }));
}
