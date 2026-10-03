/** @type schema @purpose Define bindings and request shapes for the capsule gateway Worker. */
export interface Env {
  UPSTREAM_API_URL: string;
  CAPSULE_API_TOKEN?: string;
}

export interface CapsuleRequest {
  video_url: string;
}
