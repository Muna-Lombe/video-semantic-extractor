/**
 * @type implementation
 * @purpose Expose the Python API through a Cloudflare Container.
 */
import { Container } from "@cloudflare/containers";
import type { ContainerEnv } from "./types";

export class VideoSemanticExtractorContainer extends Container<ContainerEnv> {
  defaultPort = 8000;
  sleepAfter = "10m";
  enableInternet = true;
}

export default {
  async fetch(request: Request, env: ContainerEnv): Promise<Response> {
    const container = env.VIDEO_CONTAINER.getByName("video-semantic-extractor");
    return container.fetch(request);
  },
} satisfies ExportedHandler<ContainerEnv>;