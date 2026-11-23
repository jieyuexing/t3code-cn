import type { HostResourcesSnapshot } from "@t3tools/contracts";

import { machineMemoryUsedShare } from "./machineResources.js";

export const MACHINE_HISTORY_MAX_AGE_MS = 60 * 60_000;
export const MACHINE_HISTORY_MAX_SAMPLES = 720;

export interface MachineHistorySample {
  readonly sampledAt: number;
  readonly cpuPercent: number | null;
  readonly cpuSystemPercent: number | null;
  readonly memoryUsedPercent: number | null;
  readonly memoryUsedBytes: number | null;
  readonly downloadBytesPerSecond: number | null;
  readonly uploadBytesPerSecond: number | null;
}

export interface MachineHistoryBucket {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly sampleCount: number;
  readonly avgCpuPercent: number | null;
  readonly maxCpuPercent: number | null;
  readonly avgCpuSystemPercent: number | null;
  readonly avgMemoryUsedPercent: number | null;
  readonly maxMemoryUsedPercent: number | null;
  readonly latestMemoryUsedBytes: number | null;
  readonly avgDownloadBytesPerSecond: number | null;
  readonly maxDownloadBytesPerSecond: number | null;
  readonly avgUploadBytesPerSecond: number | null;
  readonly maxUploadBytesPerSecond: number | null;
}

const EMPTY_SAMPLES: ReadonlyArray<MachineHistorySample> = [];
const buffers = new Map<string, ReadonlyArray<MachineHistorySample>>();
const listenersByEnvironment = new Map<string, Set<() => void>>();

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function averageNonNull(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    sum += value;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

function maxNonNull(values: ReadonlyArray<number | null>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    result = result === null ? value : Math.max(result, value);
  }
  return result;
}

export function extractMachineHistorySample(snapshot: HostResourcesSnapshot): MachineHistorySample {
  const cpuPercent =
    snapshot.cpuUtilization === null ? null : clampPercent(snapshot.cpuUtilization * 100);
  const cpuSystemPercent =
    snapshot.cpuCores && snapshot.cpuCores.length > 0
      ? clampPercent(
          (snapshot.cpuCores.reduce((sum, core) => sum + core.system, 0) /
            snapshot.cpuCores.length) *
            100,
        )
      : null;
  const hasMemory = snapshot.totalMemoryBytes > 0;
  const memoryUsedBytes = hasMemory
    ? Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes)
    : null;
  const memoryUsedPercent = hasMemory ? clampPercent(machineMemoryUsedShare(snapshot) * 100) : null;

  const networkReady =
    snapshot.network !== undefined &&
    snapshot.network.warmingUp !== true &&
    snapshot.network.unavailableReason === undefined;

  return {
    sampledAt: snapshot.sampledAt,
    cpuPercent,
    cpuSystemPercent,
    memoryUsedPercent,
    memoryUsedBytes,
    downloadBytesPerSecond:
      networkReady && snapshot.network?.downloadBytesPerSecond !== undefined
        ? Math.max(0, snapshot.network.downloadBytesPerSecond)
        : null,
    uploadBytesPerSecond:
      networkReady && snapshot.network?.uploadBytesPerSecond !== undefined
        ? Math.max(0, snapshot.network.uploadBytesPerSecond)
        : null,
  };
}

export function appendMachineHistorySample(
  samples: ReadonlyArray<MachineHistorySample>,
  snapshot: HostResourcesSnapshot,
  options?: {
    readonly maxAgeMs?: number;
    readonly maxSamples?: number;
  },
): ReadonlyArray<MachineHistorySample> {
  const maxAgeMs = options?.maxAgeMs ?? MACHINE_HISTORY_MAX_AGE_MS;
  const maxSamples = options?.maxSamples ?? MACHINE_HISTORY_MAX_SAMPLES;
  const nextSample = extractMachineHistorySample(snapshot);
  const lastSample = samples.at(-1);

  if (lastSample !== undefined && nextSample.sampledAt < lastSample.sampledAt) {
    return samples;
  }

  const combined =
    lastSample !== undefined && nextSample.sampledAt === lastSample.sampledAt
      ? [...samples.slice(0, -1), nextSample]
      : [...samples, nextSample];

  const minSampledAt = nextSample.sampledAt - maxAgeMs;
  const withinAge = combined.filter((item) => item.sampledAt >= minSampledAt);
  return withinAge.length > maxSamples ? withinAge.slice(-maxSamples) : withinAge;
}

export function selectMachineHistorySamples(
  samples: ReadonlyArray<MachineHistorySample>,
  windowMs: number,
  anchorMs: number,
): ReadonlyArray<MachineHistorySample> {
  const minSampledAt = anchorMs - windowMs;
  return samples.filter((item) => item.sampledAt >= minSampledAt && item.sampledAt <= anchorMs);
}

export function bucketMachineHistory(
  samples: ReadonlyArray<MachineHistorySample>,
  options: {
    readonly windowMs: number;
    readonly bucketMs: number;
    readonly anchorMs: number;
  },
): ReadonlyArray<MachineHistoryBucket> {
  const bucketMs = Math.max(1_000, options.bucketMs);
  const bucketCount = Math.max(1, Math.floor(options.windowMs / bucketMs));
  const windowStart = options.anchorMs - bucketCount * bucketMs;
  const grouped = Array.from({ length: bucketCount }, () => [] as MachineHistorySample[]);

  for (const sample of samples) {
    if (sample.sampledAt < windowStart || sample.sampledAt > options.anchorMs) continue;
    const rawIndex = Math.floor((sample.sampledAt - windowStart) / bucketMs);
    const index = Math.min(bucketCount - 1, Math.max(0, rawIndex));
    grouped[index]?.push(sample);
  }

  return grouped.map((items, index) => {
    const startedAt = windowStart + index * bucketMs;
    const endedAt = startedAt + bucketMs;
    if (items.length === 0) {
      return {
        startedAt,
        endedAt,
        sampleCount: 0,
        avgCpuPercent: null,
        maxCpuPercent: null,
        avgCpuSystemPercent: null,
        avgMemoryUsedPercent: null,
        maxMemoryUsedPercent: null,
        latestMemoryUsedBytes: null,
        avgDownloadBytesPerSecond: null,
        maxDownloadBytesPerSecond: null,
        avgUploadBytesPerSecond: null,
        maxUploadBytesPerSecond: null,
      };
    }
    const cpuValues = items.map((item) => item.cpuPercent);
    const sysValues = items.map((item) => item.cpuSystemPercent);
    const memValues = items.map((item) => item.memoryUsedPercent);
    const dlValues = items.map((item) => item.downloadBytesPerSecond);
    const ulValues = items.map((item) => item.uploadBytesPerSecond);
    let latestMemoryUsedBytes: number | null = null;
    for (const item of items) {
      if (item.memoryUsedBytes !== null) latestMemoryUsedBytes = item.memoryUsedBytes;
    }
    return {
      startedAt,
      endedAt,
      sampleCount: items.length,
      avgCpuPercent: averageNonNull(cpuValues),
      maxCpuPercent: maxNonNull(cpuValues),
      avgCpuSystemPercent: averageNonNull(sysValues),
      avgMemoryUsedPercent: averageNonNull(memValues),
      maxMemoryUsedPercent: maxNonNull(memValues),
      latestMemoryUsedBytes,
      avgDownloadBytesPerSecond: averageNonNull(dlValues),
      maxDownloadBytesPerSecond: maxNonNull(dlValues),
      avgUploadBytesPerSecond: averageNonNull(ulValues),
      maxUploadBytesPerSecond: maxNonNull(ulValues),
    };
  });
}

function notifyEnvironmentListeners(environmentId: string): void {
  const listeners = listenersByEnvironment.get(environmentId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

export function recordEnvironmentMachineSample(
  environmentId: string,
  snapshot: HostResourcesSnapshot,
): ReadonlyArray<MachineHistorySample> {
  const previous = buffers.get(environmentId) ?? EMPTY_SAMPLES;
  const next = appendMachineHistorySample(previous, snapshot);
  if (next !== previous) {
    buffers.set(environmentId, next);
    notifyEnvironmentListeners(environmentId);
  }
  return next;
}

export function getEnvironmentMachineHistory(
  environmentId: string,
): ReadonlyArray<MachineHistorySample> {
  return buffers.get(environmentId) ?? EMPTY_SAMPLES;
}

export function clearEnvironmentMachineHistory(environmentId: string): void {
  if (!buffers.has(environmentId)) return;
  buffers.delete(environmentId);
  notifyEnvironmentListeners(environmentId);
}

export function subscribeEnvironmentMachineHistory(
  environmentId: string,
  listener: () => void,
): () => void {
  let set = listenersByEnvironment.get(environmentId);
  if (!set) {
    set = new Set();
    listenersByEnvironment.set(environmentId, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByEnvironment.get(environmentId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByEnvironment.delete(environmentId);
    }
  };
}
