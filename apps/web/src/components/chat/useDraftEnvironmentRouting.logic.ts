import {
  type ExecutionEnvironmentDescriptor,
  resolveEnvironmentMachineKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveLoadBalancingWeight } from "@t3tools/shared/loadBalancing";

type MachineConfig = {
  readonly environment: Pick<ExecutionEnvironmentDescriptor, "platform">;
  readonly settings?: Pick<ServerSettings, "environmentIcon" | "loadBalancingWeight">;
} | null;

/** A machine whose config has not arrived has no kind, so it gets the neutral default. */
export function environmentLoadWeight(
  environment: { readonly serverConfig: MachineConfig } | undefined,
  explicitWeight: number | undefined,
): number {
  return resolveLoadBalancingWeight({
    explicit: explicitWeight,
    declared: environment?.serverConfig?.settings?.loadBalancingWeight ?? undefined,
    machine: environment?.serverConfig
      ? resolveEnvironmentMachineKind(environment.serverConfig)
      : undefined,
  });
}
