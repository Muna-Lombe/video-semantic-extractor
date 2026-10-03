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

  static outboundByHost = {
    "control.internal": forwardControlPlane,
  };
}

async function dispatch(env: SamplingRunnerEnv): Promise<Response> {
  const container = env.SAMPLING_CONTAINER.getByName("sampling-runner");
  return container.fetch(new Request("http://container/run-once", { method: "POST" }));
}

export default {
  async fetch(request: Request, env: SamplingRunnerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: SamplingRunnerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatch(env).then((response) => {
      if (!response.ok) throw new Error(`sampling runner dispatch failed (${response.status})`);
    }));
  },
} satisfies ExportedHandler<SamplingRunnerEnv>;
