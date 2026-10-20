/**
 * @type implementation
 * @purpose Expose the Python API through a Cloudflare Container.
 */
import { Container, ContainerProxy } from "@cloudflare/containers";
import { forwardProductControl } from "./product-control";
import type { ContainerEnv } from "./types";
export { ContainerProxy };

export class VideoSemanticExtractorContainer extends Container<ContainerEnv> {
  defaultPort = 8000;
  sleepAfter = "10m";
  enableInternet = true;
  envVars = {
    CAPSULE_VISUAL_MODE: this.env.CAPSULE_VISUAL_MODE ?? "basic",
    CAPSULE_CONTROL_PLANE_URL: "http://product-control.internal",
    CAPSULE_CONTROL_PLANE_TOKEN: "service-binding",
  };
  static {
    this.outboundByHost = { "product-control.internal": forwardProductControl };
  }
}

export default {
  async fetch(request: Request, env: ContainerEnv): Promise<Response> {
    const container = env.VIDEO_CONTAINER.getByName("video-semantic-extractor");
    return container.fetch(request);
  },
} satisfies ExportedHandler<ContainerEnv>;
