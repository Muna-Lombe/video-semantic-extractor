/** @type test @purpose Verify Container outbound handlers register with the proxy registry. */
import { describe, expect, it, vi } from "vitest";
import { forwardControlPlane } from "./sampling-runner-control";

const { outboundByHostRegistry } = vi.hoisted(() => ({
  outboundByHostRegistry: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@cloudflare/containers", () => {
  class Container {
    static get outboundByHost(): Record<string, unknown> | undefined {
      return outboundByHostRegistry.get(this.name);
    }

    static set outboundByHost(handlers: Record<string, unknown>) {
      outboundByHostRegistry.set(this.name, handlers);
    }
  }

  return { Container, ContainerProxy: class ContainerProxy {} };
});

import { SamplingRunnerContainer } from "./sampling-runner";

describe("sampling runner Container configuration", () => {
  it("registers the control-plane handler in the Containers proxy registry", () => {
    expect(outboundByHostRegistry.get("SamplingRunnerContainer")?.["control.internal"]).toBe(forwardControlPlane);
    expect(SamplingRunnerContainer.outboundByHost?.["control.internal"]).toBe(forwardControlPlane);
  });
});
