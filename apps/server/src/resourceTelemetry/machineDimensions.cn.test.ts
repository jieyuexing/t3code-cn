import type * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_NETWORK_RATE_STATE,
  advanceNetworkRateState,
  coreBreakdown,
  parseDarwinMemoryBreakdown,
  parseDarwinMemoryPressure,
  parseLinuxMemoryBreakdown,
  parseLinuxMemoryPressure,
} from "./machineDimensions.cn.ts";

const GiB = 1024 ** 3;

const M3_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   294224.
Pages active:                                1532561.
Pages inactive:                              1547284.
Pages speculative:                              6584.
Pages throttled:                                   0.
Pages wired down:                             382838.
Pages purgeable:                               36993.
"Translation faults":                     9541731279.
Pages copy-on-write:                       566451043.
Pages zero filled:                        6779030760.
Pages reactivated:                           8269006.
Pages purged:                               11888237.
File-backed pages:                           1182356.
Anonymous pages:                             1904073.
Pages stored in compressor:                   746665.
Pages occupied by compressor:                 375480.
Decompressions:                              2480833.
Compressions:                               30944861.
Pageins:                                   190122446.
Pageouts:                                        572.
Swapins:                                           0.
Swapouts:                                          0.
`;

const LINUX_MEMINFO = `MemTotal:       65852416 kB
MemFree:        12345678 kB
MemAvailable:   34567890 kB
Buffers:          512340 kB
Cached:         21345678 kB
SwapCached:            0 kB
Active:         28000000 kB
Inactive:       12000000 kB
Active(anon):   18000000 kB
Inactive(anon):   500000 kB
Active(file):   10000000 kB
Inactive(file): 11500000 kB
Unevictable:       32768 kB
Mlocked:           32768 kB
SwapTotal:       8388604 kB
SwapFree:        8388604 kB
Shmem:            654321 kB
KReclaimable:    1234560 kB
Slab:            1800000 kB
SReclaimable:    1200000 kB
SUnreclaim:       600000 kB
KernelStack:       34560 kB
PageTables:       123456 kB
`;

function cpu(times: NodeOS.CpuInfo["times"]): NodeOS.CpuInfo {
  return { model: "Apple M3 Max", speed: 4000, times };
}

describe("coreBreakdown", () => {
  it("splits each core into user (user + nice) and system (sys + irq) shares", () => {
    const before = [
      cpu({ user: 100, nice: 10, sys: 40, idle: 250, irq: 0 }),
      cpu({ user: 500, nice: 0, sys: 100, idle: 400, irq: 0 }),
      cpu({ user: 10, nice: 0, sys: 10, idle: 10, irq: 0 }),
    ];
    const after = [
      cpu({ user: 150, nice: 20, sys: 65, idle: 360, irq: 5 }),
      cpu({ user: 500, nice: 0, sys: 100, idle: 500, irq: 0 }),
      cpu({ user: 10, nice: 0, sys: 10, idle: 10, irq: 0 }),
    ];

    const result = coreBreakdown(before, after);
    expect(result).toHaveLength(3);
    // Core 0 delta: user=50, nice=10 (60), sys=25, irq=5 (30), idle=110 -> total=200.
    expect(result?.[0]?.utilization).toBeCloseTo(0.45, 9);
    expect(result?.[0]?.user).toBeCloseTo(0.3, 9);
    expect(result?.[0]?.system).toBeCloseTo(0.15, 9);
    expect(result?.[1]).toEqual({ utilization: 0, user: 0, system: 0 });
    expect(result?.[2]).toEqual({ utilization: 0, user: 0, system: 0 });
  });

  it("returns undefined when the core count changes or is empty", () => {
    expect(coreBreakdown([], [])).toBeUndefined();
    expect(
      coreBreakdown(
        [cpu({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 })],
        [
          cpu({ user: 1, nice: 0, sys: 0, idle: 0, irq: 0 }),
          cpu({ user: 1, nice: 0, sys: 0, idle: 0, irq: 0 }),
        ],
      ),
    ).toBeUndefined();
  });
});

describe("parseDarwinMemoryBreakdown", () => {
  it("computes Activity Monitor App, Wired, Compressed, and Available bytes from vm_stat", () => {
    const totalBytes = 64 * GiB;
    const breakdown = parseDarwinMemoryBreakdown(M3_VM_STAT, totalBytes);

    expect(breakdown).toEqual({
      kind: "darwin",
      appBytes: (1_904_073 - 36_993) * 16_384,
      wiredBytes: 382_838 * 16_384,
      compressedBytes: 375_480 * 16_384,
      availableBytes:
        totalBytes - ((1_904_073 - 36_993) * 16_384 + 382_838 * 16_384 + 375_480 * 16_384),
    });
  });

  it("reports unavailableReason without zeroing fields when vm_stat output is incomplete", () => {
    const breakdown = parseDarwinMemoryBreakdown("Pages free: 100.\n", 64 * GiB);
    expect(breakdown.kind).toBe("unavailable");
    if (breakdown.kind === "unavailable") {
      expect(breakdown.unavailableReason.length).toBeGreaterThan(0);
    }
  });
});

describe("parseLinuxMemoryBreakdown", () => {
  it("reports unavailableReason when /proc/meminfo omits AnonPages", () => {
    const breakdown = parseLinuxMemoryBreakdown(LINUX_MEMINFO);
    expect(breakdown.kind).toBe("unavailable");
  });

  it("parses a complete /proc/meminfo with AnonPages and falls back from KReclaimable to SReclaimable", () => {
    const full = `${LINUX_MEMINFO}AnonPages:      17845679 kB\n`;
    const breakdown = parseLinuxMemoryBreakdown(full);

    const expectedApp = (17_845_679 + 654_321) * 1024;
    const expectedCached = (512_340 + (21_345_678 - 654_321) + 1_234_560) * 1024;
    const expectedFree = 12_345_678 * 1024;
    const expectedKernel = 65_852_416 * 1024 - expectedApp - expectedCached - expectedFree;

    expect(breakdown).toEqual({
      kind: "linux",
      appBytes: expectedApp,
      kernelBytes: expectedKernel,
      cachedBytes: expectedCached,
      freeBytes: expectedFree,
    });

    const olderKernel = full.replace(/^KReclaimable:.*\n/m, "");
    const fallback = parseLinuxMemoryBreakdown(olderKernel);
    expect(fallback.kind).toBe("linux");
    if (fallback.kind === "linux") {
      expect(fallback.cachedBytes).toBe((512_340 + (21_345_678 - 654_321) + 1_200_000) * 1024);
    }
  });

  it("reports unavailableReason when a cgroup memory limit caps the container", () => {
    const full = `${LINUX_MEMINFO}AnonPages:      17845679 kB\n`;
    const breakdown = parseLinuxMemoryBreakdown(full, { cgroupCapped: true });
    expect(breakdown.kind).toBe("unavailable");
  });
});

describe("memory pressure parsers", () => {
  it("maps darwin kern.memorystatus_vm_pressure_level 1/2/4 to normal/warning/critical", () => {
    expect(parseDarwinMemoryPressure("1\n")).toEqual({ level: "normal" });
    expect(parseDarwinMemoryPressure("2\n")).toEqual({ level: "warning" });
    expect(parseDarwinMemoryPressure("4\n")).toEqual({ level: "critical" });
    expect(parseDarwinMemoryPressure("")).toMatchObject({
      unavailableReason: expect.any(String),
    });
    expect(parseDarwinMemoryPressure("99\n").level).toBeUndefined();
  });

  it("maps linux /proc/pressure/memory PSI stalls to normal/warning/critical", () => {
    expect(
      parseLinuxMemoryPressure(
        "some avg10=0.45 avg60=0.12 avg300=0.05 total=81234\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=120\n",
      ),
    ).toEqual({ level: "normal", someAvg10: 0.45, fullAvg10: 0 });

    expect(
      parseLinuxMemoryPressure(
        "some avg10=12.40 avg60=6.10 avg300=2.00 total=900000\nfull avg10=0.40 avg60=0.10 avg300=0.00 total=4500\n",
      ),
    ).toEqual({ level: "warning", someAvg10: 12.4, fullAvg10: 0.4 });

    expect(
      parseLinuxMemoryPressure(
        "some avg10=35.00 avg60=20.00 avg300=8.00 total=3200000\nfull avg10=6.25 avg60=3.10 avg300=1.00 total=520000\n",
      ),
    ).toEqual({ level: "critical", someAvg10: 35, fullAvg10: 6.25 });

    const missing = parseLinuxMemoryPressure("");
    expect(missing.level).toBeUndefined();
    expect(missing.unavailableReason).toBeTruthy();
  });
});

describe("advanceNetworkRateState", () => {
  it("warms up on the first sample, computes byte/s rates, preserves sub-window rates, and resets on counter rollback or stale gaps", () => {
    const first = advanceNetworkRateState(INITIAL_NETWORK_RATE_STATE, {
      sampledAtUnixMs: 1_000,
      receivedBytes: 10_000,
      transmittedBytes: 5_000,
      interfaceCount: 2,
    });
    expect(first.reading).toEqual({
      sampledAt: 1_000,
      warmingUp: true,
      unavailableReason: expect.any(String),
    });
    expect(first.reading.downloadBytesPerSecond).toBeUndefined();

    // Concurrent call 50 ms later keeps the initial baseline at 1_000 ms.
    const burst = advanceNetworkRateState(first.state, {
      sampledAtUnixMs: 1_050,
      receivedBytes: 10_100,
      transmittedBytes: 5_050,
      interfaceCount: 2,
    });
    expect(burst.reading.warmingUp).toBe(true);
    expect(burst.state.baseline?.sampledAtUnixMs).toBe(1_000);

    // 2 seconds after first sample: +20_000 rx -> 10_000 B/s, +4_000 tx -> 2_000 B/s.
    const second = advanceNetworkRateState(burst.state, {
      sampledAtUnixMs: 3_000,
      receivedBytes: 30_000,
      transmittedBytes: 9_000,
      interfaceCount: 2,
    });
    expect(second.reading).toEqual({
      sampledAt: 3_000,
      downloadBytesPerSecond: 10_000,
      uploadBytesPerSecond: 2_000,
    });

    // Sub-window call 20 ms later returns the established rate without clobbering baseline.
    const subWindow = advanceNetworkRateState(second.state, {
      sampledAtUnixMs: 3_020,
      receivedBytes: 30_000,
      transmittedBytes: 9_000,
      interfaceCount: 2,
    });
    expect(subWindow.reading).toEqual(second.reading);
    expect(subWindow.state.baseline?.sampledAtUnixMs).toBe(3_000);

    // Counter rollback (e.g. VPN tunnel torn down) re-warms instead of emitting negative rates.
    const rolledBack = advanceNetworkRateState(subWindow.state, {
      sampledAtUnixMs: 8_000,
      receivedBytes: 25_000,
      transmittedBytes: 9_500,
      interfaceCount: 1,
    });
    expect(rolledBack.reading.warmingUp).toBe(true);
    expect(rolledBack.reading.downloadBytesPerSecond).toBeUndefined();

    // Stale baseline (> 30 s gap) re-warms instead of smearing old traffic.
    const stale = advanceNetworkRateState(rolledBack.state, {
      sampledAtUnixMs: 50_000,
      receivedBytes: 125_000,
      transmittedBytes: 59_500,
      interfaceCount: 1,
    });
    expect(stale.reading.warmingUp).toBe(true);
    expect(stale.reading.downloadBytesPerSecond).toBeUndefined();
  });

  it("propagates native unavailableReason without inventing zeros", () => {
    const res = advanceNetworkRateState(INITIAL_NETWORK_RATE_STATE, {
      sampledAtUnixMs: 2_000,
      receivedBytes: 0,
      transmittedBytes: 0,
      interfaceCount: 0,
      unavailableReason: "No active non-loopback network interfaces found.",
    });
    expect(res.reading).toEqual({
      sampledAt: 2_000,
      unavailableReason: "No active non-loopback network interfaces found.",
    });
  });
});
