import { describe, expect, it } from "vite-plus/test";

import { ENVIRONMENT_MACHINE_KINDS, type EnvironmentMachineKind } from "@t3tools/contracts";

import { chooseLoadBalancedEnvironment, resolveLoadBalancingWeight } from "./loadBalancing.ts";

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});

describe("resolving a machine's load balancing weight", () => {
  const defaults: Record<EnvironmentMachineKind, number> = {
    laptop: 50,
    server: 100,
    cloud: 100,
    linux: 100,
    desktop: 100,
    "mac-mini": 100,
    "mac-studio": 100,
  };

  it.each(ENVIRONMENT_MACHINE_KINDS)("defaults a %s by its kind", (machine) => {
    expect(resolveLoadBalancingWeight({ machine })).toBe(defaults[machine]);
  });

  it("is neutral when the kind is unknown, and the client's pick beats the kind", () => {
    expect(resolveLoadBalancingWeight({})).toBe(50);
    expect(resolveLoadBalancingWeight({ explicit: 25, machine: "server" })).toBe(25);
  });

  it("keeps a client's explicit zero, which leaves the machine out", () => {
    const resources = {
      sampledAt: 100_000,
      cpuUtilization: 0.1,
      cpuCount: 8,
      availableMemoryBytes: 8_000,
      totalMemoryBytes: 16_000,
    };
    const weight = resolveLoadBalancingWeight({ explicit: 0, machine: "server" });
    expect(weight).toBe(0);
    expect(
      chooseLoadBalancedEnvironment([{ environmentId: "manual-only", resources, weight }], 100_000),
    ).toBeNull();
  });
});
