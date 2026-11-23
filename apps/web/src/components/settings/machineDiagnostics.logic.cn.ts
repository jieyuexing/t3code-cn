import type { MachineHistoryBucket } from "@t3tools/client-runtime/machine-resources-history-cn";
import type { HostResourcesSnapshot, HostVolume } from "@t3tools/contracts";

export type MachineSubtab =
  | "overview"
  | "cpu-memory"
  | "storage"
  | "network"
  | "processes"
  | "hardware";

export interface MemorySegmentDescriptor {
  readonly id: "app" | "wired" | "compressed" | "available" | "kernel" | "cached" | "free";
  readonly bytes: number;
  readonly sharePercent: number;
  readonly barClassName: string;
  readonly dotClassName: string;
}

export function formatOneDecimalPercent(share: number): string {
  return `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%`;
}

export function formatClockTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function pickPrimaryT3Volume(snapshot: HostResourcesSnapshot): {
  readonly volume: HostVolume | null;
  readonly isT3Home: boolean;
} {
  const volumes = snapshot.storage?.volumes;
  if (!volumes || volumes.length === 0) {
    return { volume: null, isT3Home: false };
  }
  const t3Home = volumes.find((item) => item.roles.includes("t3Home"));
  if (t3Home) {
    return { volume: t3Home, isT3Home: true };
  }
  return { volume: volumes[0] ?? null, isT3Home: false };
}

export function computeMemorySegments(
  snapshot: HostResourcesSnapshot,
):
  | { readonly kind: "segments"; readonly segments: ReadonlyArray<MemorySegmentDescriptor> }
  | { readonly kind: "unavailable"; readonly reason: string | null } {
  const breakdown = snapshot.memoryBreakdown;
  if (!breakdown) {
    return { kind: "unavailable", reason: null };
  }
  if (breakdown.kind === "unavailable") {
    return { kind: "unavailable", reason: breakdown.unavailableReason };
  }

  if (breakdown.kind === "darwin") {
    const total = Math.max(
      1,
      snapshot.totalMemoryBytes,
      breakdown.appBytes +
        breakdown.wiredBytes +
        breakdown.compressedBytes +
        breakdown.availableBytes,
    );
    return {
      kind: "segments",
      segments: [
        {
          id: "app",
          bytes: breakdown.appBytes,
          sharePercent: (breakdown.appBytes / total) * 100,
          barClassName: "bg-primary",
          dotClassName: "bg-primary",
        },
        {
          id: "wired",
          bytes: breakdown.wiredBytes,
          sharePercent: (breakdown.wiredBytes / total) * 100,
          barClassName: "bg-violet-500",
          dotClassName: "bg-violet-500",
        },
        {
          id: "compressed",
          bytes: breakdown.compressedBytes,
          sharePercent: (breakdown.compressedBytes / total) * 100,
          barClassName: "bg-warning",
          dotClassName: "bg-warning",
        },
        {
          id: "available",
          bytes: breakdown.availableBytes,
          sharePercent: (breakdown.availableBytes / total) * 100,
          barClassName: "bg-muted-foreground/25",
          dotClassName: "bg-muted-foreground/45",
        },
      ],
    };
  }

  const total = Math.max(
    1,
    snapshot.totalMemoryBytes,
    breakdown.appBytes + breakdown.kernelBytes + breakdown.cachedBytes + breakdown.freeBytes,
  );
  return {
    kind: "segments",
    segments: [
      {
        id: "app",
        bytes: breakdown.appBytes,
        sharePercent: (breakdown.appBytes / total) * 100,
        barClassName: "bg-primary",
        dotClassName: "bg-primary",
      },
      {
        id: "kernel",
        bytes: breakdown.kernelBytes,
        sharePercent: (breakdown.kernelBytes / total) * 100,
        barClassName: "bg-violet-500",
        dotClassName: "bg-violet-500",
      },
      {
        id: "cached",
        bytes: breakdown.cachedBytes,
        sharePercent: (breakdown.cachedBytes / total) * 100,
        barClassName: "bg-warning",
        dotClassName: "bg-warning",
      },
      {
        id: "free",
        bytes: breakdown.freeBytes,
        sharePercent: (breakdown.freeBytes / total) * 100,
        barClassName: "bg-muted-foreground/25",
        dotClassName: "bg-muted-foreground/45",
      },
    ],
  };
}

export function peakBucketMetric(
  buckets: ReadonlyArray<MachineHistoryBucket>,
  pick: (bucket: MachineHistoryBucket) => number | null,
): number | null {
  let result: number | null = null;
  for (const bucket of buckets) {
    const value = pick(bucket);
    if (value === null) continue;
    result = result === null ? value : Math.max(result, value);
  }
  return result;
}
