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
  CONTROL_DB: D1Database;
  DATASET_DB: D1Database;
  ADMIN_TOKEN: string;
  RUNNER_TOKEN?: string;
  ASSETS: Fetcher;
}

export interface ContainerEnv extends Env {
  VIDEO_CONTAINER: DurableObjectNamespace;
}

export interface CapsuleRequest {
  video_url: string;
}
