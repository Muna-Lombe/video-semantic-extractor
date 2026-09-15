/**
 * @type schema
 * @purpose Define strict gateway bindings and request shapes.
 */
export interface Env {
  UPSTREAM_API_URL: string;
  CAPSULE_API_TOKEN?: string;
}

export interface ContainerEnv extends Env {
  VIDEO_CONTAINER: DurableObjectNamespace;
}

export interface CapsuleRequest {
  video_url: string;
}
