import type { EnvironmentMachineKind, HostResourcesSnapshot } from "@t3tools/contracts";

const DEFAULT_WEIGHT = 50;
/** A laptop sleeps and moves; the other kinds are meant to stay on. */
const DEFAULT_WEIGHT_BY_MACHINE: Record<EnvironmentMachineKind, number> = {
  laptop: 50,
  server: 100,
  cloud: 100,
  linux: 100,
  desktop: 100,
  "mac-mini": 100,
  "mac-studio": 100,
};

/** The client's own pick wins, then what the machine declares, then its kind's default. */
export function resolveLoadBalancingWeight(input: {
  readonly explicit?: number | undefined;
  readonly declared?: number | undefined;
  readonly machine?: EnvironmentMachineKind | undefined;
}): number {
  return (
    input.explicit ??
    input.declared ??
    (input.machine === undefined ? DEFAULT_WEIGHT : DEFAULT_WEIGHT_BY_MACHINE[input.machine])
  );
}

export interface LoadBalancingCandidate {
  environmentId: string;
  resources: HostResourcesSnapshot | null;
  /** Client receipt time avoids comparing clocks on different machines. */
  receivedAt?: number;
  weight: number;
}

/** Why a machine cannot be chosen at all: the user left it out, or its load reading rules it out. */
export type LoadBalancingExclusion = "weight_zero" | "overloaded";

/** `overloaded` also covers a reading that is stale, from the future or incomplete. */
export function loadBalancingExclusion(
  { resources, receivedAt, weight }: LoadBalancingCandidate,
  now: number,
): LoadBalancingExclusion | null {
  if (!Number.isFinite(weight) || weight <= 0) return "weight_zero";
  const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
  if (
    !resources ||
    now - sampledAt > 15_000 ||
    sampledAt > now + 5_000 ||
    resources.cpuUtilization === null ||
    resources.cpuUtilization >= 0.95 ||
    resources.totalMemoryBytes <= 0 ||
    resources.cpuCount <= 0 ||
    resources.availableMemoryBytes / resources.totalMemoryBytes <= 0.05
  ) {
    return "overloaded";
  }
  return null;
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<LoadBalancingCandidate>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const { environmentId, resources, weight } = candidate;
    if (!resources || loadBalancingExclusion(candidate, now) !== null) continue;
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    const score =
      weight * resources.cpuCount * (1 - (resources.cpuUtilization ?? 1)) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}
