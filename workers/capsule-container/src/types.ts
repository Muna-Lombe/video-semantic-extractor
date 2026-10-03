/** @type schema @purpose Define bindings for the Product capsule Container Worker. */
export interface ContainerEnv {
  UPSTREAM_API_URL: string;
  CAPSULE_API_TOKEN?: string;
  VIDEO_CONTAINER: DurableObjectNamespace;
}
