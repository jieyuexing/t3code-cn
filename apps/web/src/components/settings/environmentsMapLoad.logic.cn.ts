import {
  machineMemoryUsedShare,
  machineStorageState,
  machineVolumeTone,
  type MachineVolumeTone,
} from "@t3tools/client-runtime/machine-resources";
import type { HostResourcesSnapshot, HostVolume } from "@t3tools/contracts";

/** Extra vertical space added to each environment card when map load overlay is on. */
export const CARD_LOAD_HEIGHT = 18;

/** Memory used share at or above which the node card surfaces a high-memory badge. */
const MEMORY_PRESSURE_HIGH_SHARE = 0.85;

export type EnvironmentLoadTone = MachineVolumeTone;

export type EnvironmentLoadUnavailableReason =
  | "off"
  | "connecting"
  | "disconnected"
  | "forbidden"
  | "error"
  | "unsupported";

export interface EnvironmentLoadDiskWarning {
  readonly tone: "warning" | "danger";
  readonly availableBytes: number;
  readonly mountPoint: string;
  readonly roles: HostVolume["roles"];
}

export type EnvironmentLoadState =
  | {
      readonly kind: "unavailable";
      readonly reason: EnvironmentLoadUnavailableReason;
      readonly errorMessage?: string;
    }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly tone: EnvironmentLoadTone;
      readonly cpuPercent: number | null;
      readonly availableMemoryBytes: number | null;
      readonly totalMemoryBytes: number;
      readonly memoryUsedShare: number;
      readonly memoryPressureHigh: boolean;
      readonly diskWarning: EnvironmentLoadDiskWarning | null;
    };

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;

export function formatCompactLoadMemory(bytes: number): string {
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  if (bytes < TB) {
    const gigabytes = bytes / GB;
    return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
  }
  const terabytes = bytes / TB;
  return `${terabytes >= 10 ? Math.round(terabytes) : terabytes.toFixed(1)} TB`;
}

export function formatCompactDiskBadgeValue(bytes: number): string {
  if (bytes < GB) return `${Math.round(bytes / MB)}M`;
  if (bytes < TB) {
    const gigabytes = bytes / GB;
    return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)}G`;
  }
  const terabytes = bytes / TB;
  return `${terabytes >= 10 ? Math.round(terabytes) : terabytes.toFixed(1)}T`;
}

function pickWorstDiskWarning(
  snapshot: Pick<HostResourcesSnapshot, "storage">,
): EnvironmentLoadDiskWarning | null {
  const storage = machineStorageState(snapshot);
  if (storage.kind !== "volumes") return null;
  let worst: { readonly volume: HostVolume; readonly tone: "warning" | "danger" } | null = null;
  for (const volume of storage.volumes) {
    const tone = machineVolumeTone(volume);
    if (tone === "default") continue;
    if (worst === null) {
      worst = { volume, tone };
      continue;
    }
    if (worst.tone !== tone) {
      if (tone === "danger") worst = { volume, tone };
      continue;
    }
    const currentT3 = volume.roles.includes("t3Home");
    const worstT3 = worst.volume.roles.includes("t3Home");
    if (currentT3 !== worstT3) {
      if (currentT3) worst = { volume, tone };
      continue;
    }
    if (volume.availableBytes < worst.volume.availableBytes) {
      worst = { volume, tone };
    }
  }
  return worst === null
    ? null
    : {
        tone: worst.tone,
        availableBytes: worst.volume.availableBytes,
        mountPoint: worst.volume.mountPoint,
        roles: worst.volume.roles,
      };
}

export function evaluateEnvironmentLoad(
  snapshot: HostResourcesSnapshot | null,
  input: {
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly connecting?: boolean;
    readonly canRead: boolean;
    readonly isPending: boolean;
    readonly error: string | null;
  },
): EnvironmentLoadState {
  if (!input.enabled) return { kind: "unavailable", reason: "off" };
  if (!input.connected) {
    return {
      kind: "unavailable",
      reason: input.connecting ? "connecting" : "disconnected",
    };
  }
  if (!input.canRead) return { kind: "unavailable", reason: "forbidden" };
  if (snapshot === null) {
    if (input.error !== null) {
      return { kind: "unavailable", reason: "error", errorMessage: input.error };
    }
    return { kind: "loading" };
  }
  const cpuPercent =
    snapshot.cpuUtilization === null ? null : Math.round(snapshot.cpuUtilization * 100);
  const availableMemoryBytes = snapshot.totalMemoryBytes > 0 ? snapshot.availableMemoryBytes : null;
  if (cpuPercent === null && availableMemoryBytes === null) {
    return { kind: "unavailable", reason: "unsupported" };
  }
  const memoryUsedShare = machineMemoryUsedShare(snapshot);
  const memoryPressureHigh =
    snapshot.totalMemoryBytes > 0 && memoryUsedShare >= MEMORY_PRESSURE_HIGH_SHARE;
  const diskWarning = pickWorstDiskWarning(snapshot);
  const tone: EnvironmentLoadTone =
    diskWarning?.tone === "danger"
      ? "danger"
      : diskWarning?.tone === "warning" || memoryPressureHigh
        ? "warning"
        : "default";
  return {
    kind: "ready",
    tone,
    cpuPercent,
    availableMemoryBytes,
    totalMemoryBytes: snapshot.totalMemoryBytes,
    memoryUsedShare,
    memoryPressureHigh,
    diskWarning,
  };
}
