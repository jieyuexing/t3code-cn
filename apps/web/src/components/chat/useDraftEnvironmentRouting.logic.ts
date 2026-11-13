import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { resolveLoadBalancingWeight } from "@t3tools/shared/loadBalancing";

type MachineConfig = Parameters<typeof resolveEnvironmentMachineKind>[0];

/** A machine whose config has not arrived has no kind, so it gets the neutral default. */
export function environmentLoadWeight(
  environment: { readonly serverConfig: MachineConfig } | undefined,
  explicitWeight: number | undefined,
): number {
  return resolveLoadBalancingWeight({
    explicit: explicitWeight,
    machine: environment?.serverConfig
      ? resolveEnvironmentMachineKind(environment.serverConfig)
      : undefined,
  });
}
