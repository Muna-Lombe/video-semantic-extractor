/** @type implementation @purpose Schedule and privately connect the sampling Container to Internals. */
import { Container, ContainerProxy } from "@cloudflare/containers";
import { forwardControlPlane, type RunnerControlEnv } from "./sampling-runner-control";

interface SamplingRunnerEnv extends RunnerControlEnv {
  SAMPLING_CONTAINER: DurableObjectNamespace;
  CONTROL_PLANE: Fetcher;
  RUNNER_TOKEN: string;
}

export { ContainerProxy };

export class SamplingRunnerContainer extends Container<SamplingRunnerEnv> {
  defaultPort = 8000;
  sleepAfter = "10m";
  enableInternet = true;

  static {
    // Use the base-class setter so the ContainerProxy receives this handler.
    this.outboundByHost = {
      "control.internal": forwardControlPlane,
    };
  }
}

async function dispatch(env: SamplingRunnerEnv): Promise<Response> {
  const container = env.SAMPLING_CONTAINER.getByName("sampling-runner");
  const startedAt = Date.now();
  console.log({ event: "sampling_runner_dispatch_started" });
  try {
    const response = await container.fetch(new Request("http://container/run-once", { method: "POST" }));
    console.log({
      event: "sampling_runner_dispatch_completed",
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    if (!response.ok) throw new Error(`sampling runner dispatch failed (${response.status})`);
    return response;
  } catch (error) {
    console.error({
      event: "sampling_runner_dispatch_failed",
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

export default {
  async fetch(request: Request, env: SamplingRunnerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: SamplingRunnerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatch(env));
  },
} satisfies ExportedHandler<SamplingRunnerEnv>;
