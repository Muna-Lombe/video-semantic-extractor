/** @type schema @purpose Define bindings for the Product capsule Container Worker. */
import type { ProductControlEnv } from "./product-control";
export interface ContainerEnv extends ProductControlEnv {
  UPSTREAM_API_URL: string;
  CAPSULE_API_TOKEN?: string;
  VIDEO_CONTAINER: DurableObjectNamespace;
}
