import {
  type ExecutionEnvironmentDescriptor,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveEnvironmentMachineKind,
  type ServerProvider,
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

type ProviderState = Pick<
  ServerProvider,
  "instanceId" | "driver" | "installed" | "status" | "auth" | "availability"
> & {
  /** Enabled for this project, not just on the machine. */
  readonly enabled: boolean;
};

/** Why automatic selection leaves this machine out, or null when it is a candidate. */
export function autoSelectionBlocker(input: {
  readonly connected: boolean;
  readonly weight: number;
  readonly holdsReferencedThreadContexts: boolean;
  readonly providers: ReadonlyArray<ProviderState> | undefined;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
}): string | null {
  if (!input.connected) return "Not connected";
  if (input.weight <= 0) return "Manual only (weight 0)";
  if (!input.holdsReferencedThreadContexts) return "Thread context is on another machine";
  const candidates = (input.providers ?? []).filter(
    (provider) =>
      (input.activeProviderInstanceId === null ||
        provider.instanceId === input.activeProviderInstanceId) &&
      provider.driver === input.selectedProvider,
  );
  if (candidates.length === 0) return "Provider isn't installed here";
  const blockers = candidates.map(providerBlocker);
  return blockers.includes(null) ? null : blockers[0]!;
}

function providerBlocker(provider: ProviderState): string | null {
  if (!provider.installed) return "Provider isn't installed here";
  if (!provider.enabled) return "Provider is disabled for this project";
  if (provider.status === "error") return "Provider reports an error";
  if (provider.auth.status === "unauthenticated") return "Provider isn't signed in";
  if (provider.availability === "unavailable") return "Provider is unavailable";
  return null;
}
