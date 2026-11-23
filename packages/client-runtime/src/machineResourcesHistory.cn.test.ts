import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MACHINE_HISTORY_MAX_AGE_MS,
  MACHINE_HISTORY_MAX_SAMPLES,
  appendMachineHistorySample,
  bucketMachineHistory,
  clearEnvironmentMachineHistory,
  extractMachineHistorySample,
  getEnvironmentMachineHistory,
  recordEnvironmentMachineSample,
  selectMachineHistorySamples,
  subscribeEnvironmentMachineHistory,
  type MachineHistorySample,
} from "./machineResourcesHistory.cn.js";

const GiB = 1024 ** 3;

function makeSnapshot(
  sampledAt: number,
  overrides: Partial<HostResourcesSnapshot> = {},
): HostResourcesSnapshot {
  return {
    sampledAt,
    cpuUtilization: 0.25,
    cpuCount: 8,
    availableMemoryBytes: 24 * GiB,
    totalMemoryBytes: 64 * GiB,
    cpuCores: [
      { utilization: 0.3, user: 0.2, system: 0.1 },
      { utilization: 0.2, user: 0.16, system: 0.04 },
    ],
    network: {
      sampledAt,
      downloadBytesPerSecond: 4_000_000,
      uploadBytesPerSecond: 500_000,
    },
    ...overrides,
  };
}

describe("machineResourcesHistory.cn", () => {
  it("extracts compact metrics and keeps null instead of zero for unavailable or warming-up fields", () => {
    const sample = extractMachineHistorySample({
      sampledAt: 1_000,
      cpuUtilization: null,
      cpuCount: 8,
      totalMemoryBytes: 0,
      availableMemoryBytes: 0,
      network: {
        sampledAt: 1_000,
        warmingUp: true,
      },
    });

    expect(sample).toEqual({
      sampledAt: 1_000,
      cpuPercent: null,
      cpuSystemPercent: null,
      memoryUsedPercent: null,
      memoryUsedBytes: null,
      downloadBytesPerSecond: null,
      uploadBytesPerSecond: null,
    });
  });

  it("appends samples, deduplicates identical sampledAt, and computes CPU system share", () => {
    let buffer: ReadonlyArray<MachineHistorySample> = [];
    buffer = appendMachineHistorySample(buffer, makeSnapshot(10_000));
    buffer = appendMachineHistorySample(buffer, makeSnapshot(10_000, { cpuUtilization: 0.5 }));
    buffer = appendMachineHistorySample(buffer, makeSnapshot(15_000, { cpuUtilization: 0.4 }));

    expect(buffer).toHaveLength(2);
    expect(buffer[0]?.cpuPercent).toBeCloseTo(50);
    expect(buffer[0]?.cpuSystemPercent).toBeCloseTo(7);
    expect(buffer[0]?.memoryUsedPercent).toBeCloseTo(62.5);
    expect(buffer[0]?.memoryUsedBytes).toBe(40 * GiB);
    expect(buffer[1]?.cpuPercent).toBeCloseTo(40);
  });

  it("evicts samples older than 1 hour and caps total capacity at 720 entries", () => {
    let buffer: ReadonlyArray<MachineHistorySample> = [];
    const start = 1_000_000;
    for (let index = 0; index < MACHINE_HISTORY_MAX_SAMPLES + 25; index += 1) {
      buffer = appendMachineHistorySample(
        buffer,
        makeSnapshot(start + index * 4_000, {
          cpuUtilization: (index % 100) / 100,
        }),
      );
    }

    expect(buffer).toHaveLength(MACHINE_HISTORY_MAX_SAMPLES);
    expect(buffer[0]?.sampledAt).toBe(start + 25 * 4_000);

    const jumpedTimestamp =
      (buffer.at(-1)?.sampledAt ?? start) + MACHINE_HISTORY_MAX_AGE_MS + 5_000;
    const afterAgeEviction = appendMachineHistorySample(buffer, makeSnapshot(jumpedTimestamp));
    expect(afterAgeEviction).toHaveLength(1);
    expect(afterAgeEviction[0]?.sampledAt).toBe(jumpedTimestamp);
  });

  it("slices samples by window and aggregates fixed-width chart buckets", () => {
    let buffer: ReadonlyArray<MachineHistorySample> = [];
    buffer = appendMachineHistorySample(buffer, makeSnapshot(100_000, { cpuUtilization: 0.9 }));
    buffer = appendMachineHistorySample(buffer, makeSnapshot(405_000, { cpuUtilization: 0.2 }));
    buffer = appendMachineHistorySample(buffer, makeSnapshot(410_000, { cpuUtilization: 0.6 }));

    const withinFiveMin = selectMachineHistorySamples(buffer, 5 * 60_000, 415_000);
    expect(withinFiveMin.map((item) => item.sampledAt)).toEqual([405_000, 410_000]);

    const buckets = bucketMachineHistory(buffer, {
      windowMs: 5 * 60_000,
      bucketMs: 15_000,
      anchorMs: 415_000,
    });
    expect(buckets).toHaveLength(20);
    const lastBucket = buckets.at(-1);
    expect(lastBucket?.sampleCount).toBe(2);
    expect(lastBucket?.avgCpuPercent).toBeCloseTo(40);
    expect(lastBucket?.maxCpuPercent).toBeCloseTo(60);
    expect(buckets[0]?.sampleCount).toBe(0);
    expect(buckets[0]?.avgCpuPercent).toBeNull();
  });

  it("partitions environment buffers and clears an environment on unmount without touching peers", () => {
    clearEnvironmentMachineHistory("env-a");
    clearEnvironmentMachineHistory("env-b");

    let notifications = 0;
    const unsubscribe = subscribeEnvironmentMachineHistory("env-a", () => {
      notifications += 1;
    });

    recordEnvironmentMachineSample("env-a", makeSnapshot(50_000));
    recordEnvironmentMachineSample("env-a", makeSnapshot(55_000));
    recordEnvironmentMachineSample("env-b", makeSnapshot(55_000, { cpuUtilization: 0.8 }));

    expect(getEnvironmentMachineHistory("env-a")).toHaveLength(2);
    expect(getEnvironmentMachineHistory("env-b")).toHaveLength(1);
    expect(notifications).toBe(2);

    clearEnvironmentMachineHistory("env-a");
    expect(getEnvironmentMachineHistory("env-a")).toEqual([]);
    expect(getEnvironmentMachineHistory("env-b")).toHaveLength(1);
    expect(notifications).toBe(3);

    unsubscribe();
    clearEnvironmentMachineHistory("env-b");
  });
});
