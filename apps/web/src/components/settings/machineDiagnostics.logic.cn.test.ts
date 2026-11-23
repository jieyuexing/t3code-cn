import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeMemorySegments,
  formatClockTimestamp,
  formatOneDecimalPercent,
  peakBucketMetric,
  pickPrimaryT3Volume,
} from "./machineDiagnostics.logic.cn";

const GiB = 1024 ** 3;

function baseSnapshot(overrides: Partial<HostResourcesSnapshot> = {}): HostResourcesSnapshot {
  return {
    sampledAt: 1_700_000_000_000,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 24 * GiB,
    totalMemoryBytes: 64 * GiB,
    ...overrides,
  };
}

describe("machineDiagnostics.logic.cn", () => {
  it("computes darwin and linux memory breakdown shares and preserves unavailable reasons", () => {
    const darwin = computeMemorySegments(
      baseSnapshot({
        memoryBreakdown: {
          kind: "darwin",
          appBytes: 32 * GiB,
          wiredBytes: 6 * GiB,
          compressedBytes: 2 * GiB,
          availableBytes: 24 * GiB,
        },
      }),
    );
    expect(darwin.kind).toBe("segments");
    if (darwin.kind === "segments") {
      expect(darwin.segments.map((item) => item.id)).toEqual([
        "app",
        "wired",
        "compressed",
        "available",
      ]);
      expect(darwin.segments[0]?.sharePercent).toBeCloseTo(50);
    }

    const linux = computeMemorySegments(
      baseSnapshot({
        memoryBreakdown: {
          kind: "linux",
          appBytes: 20 * GiB,
          kernelBytes: 4 * GiB,
          cachedBytes: 16 * GiB,
          freeBytes: 24 * GiB,
        },
      }),
    );
    expect(linux.kind).toBe("segments");
    if (linux.kind === "segments") {
      expect(linux.segments.map((item) => item.id)).toEqual(["app", "kernel", "cached", "free"]);
    }

    const unavailable = computeMemorySegments(
      baseSnapshot({
        memoryBreakdown: {
          kind: "unavailable",
          unavailableReason: "Windows memory composition is not supported",
        },
      }),
    );
    expect(unavailable).toEqual({
      kind: "unavailable",
      reason: "Windows memory composition is not supported",
    });
  });

  it("picks the T3 data volume first and formats percentages and peaks", () => {
    const picked = pickPrimaryT3Volume(
      baseSnapshot({
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/Volumes/Other",
              name: "Other",
              fileSystem: "apfs",
              totalBytes: 100 * GiB,
              availableBytes: 50 * GiB,
              roles: ["worktrees"],
            },
            {
              mountPoint: "/",
              name: "Macintosh HD",
              fileSystem: "apfs",
              totalBytes: 500 * GiB,
              availableBytes: 200 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      }),
    );
    expect(picked.isT3Home).toBe(true);
    expect(picked.volume?.mountPoint).toBe("/");
    expect(formatOneDecimalPercent(0.1424)).toBe("14.2%");
    expect(formatClockTimestamp(1_700_000_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(
      peakBucketMetric(
        [
          {
            startedAt: 0,
            endedAt: 1,
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
          },
          {
            startedAt: 1,
            endedAt: 2,
            sampleCount: 1,
            avgCpuPercent: 22,
            maxCpuPercent: 48.5,
            avgCpuSystemPercent: 6,
            avgMemoryUsedPercent: 60,
            maxMemoryUsedPercent: 60,
            latestMemoryUsedBytes: 32 * GiB,
            avgDownloadBytesPerSecond: 1000,
            maxDownloadBytesPerSecond: 2000,
            avgUploadBytesPerSecond: 500,
            maxUploadBytesPerSecond: 800,
          },
        ],
        (bucket) => bucket.maxCpuPercent,
      ),
    ).toBe(48.5);
  });
});
