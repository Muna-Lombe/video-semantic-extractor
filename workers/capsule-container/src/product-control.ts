/** @type implementation @purpose Scope Product Container access to read-only release and model inputs. */
export interface ProductControlEnv {
  CONTROL_PLANE?: Fetcher;
  CAPSULE_CONTROL_TOKEN?: string;
  CAPSULE_VISUAL_MODE?: "basic" | "ocr" | "governed";
}

export async function forwardProductControl(request: Request, env: ProductControlEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.search || !/^\/api\/internal\/v1\/(releases\/active\/execution|models\/mv_[a-f0-9]{32}\/artifact)$/.test(url.pathname)) return new Response("Product input path is not allowed", { status: 403 });
  if (!env.CONTROL_PLANE || !env.CAPSULE_CONTROL_TOKEN) return new Response("Product control-plane access is not configured", { status: 503 });
  return env.CONTROL_PLANE.fetch(new Request(`https://control-plane.internal${url.pathname}`, {
    method: "GET", redirect: "manual", headers: { authorization: `Bearer ${env.CAPSULE_CONTROL_TOKEN}`, accept: "application/json, application/onnx" },
  }));
}
