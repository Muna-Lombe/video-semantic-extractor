/**
 * @type schema
 * @purpose Define strict gateway bindings and request shapes.
 */
export interface Env {
  UPSTREAM_API_URL: string;
  CAPSULE_API_TOKEN?: string;
}

export interface AdjudicationEnv {
  REVIEW_BUCKET: R2Bucket;
  ADMIN_TOKEN: string;
  ASSETS: Fetcher;
}

export interface ContainerEnv extends Env {
  VIDEO_CONTAINER: DurableObjectNamespace;
}

export interface CapsuleRequest {
  video_url: string;
}
