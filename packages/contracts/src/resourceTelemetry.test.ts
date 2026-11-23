import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HostResourcesSnapshot,
  ResourceMonitorEvent,
  ResourceMonitorHelloEvent,
} from "./resourceTelemetry.ts";

const decodeSnapshot = Schema.decodeUnknownSync(HostResourcesSnapshot);
const decodeHello = Schema.decodeSync(ResourceMonitorHelloEvent);
const decodeMonitorEvent = Schema.decodeSync(ResourceMonitorEvent);

describe("HostResourcesSnapshot", () => {
  it("decodes a snapshot from a server that predates machine details", () => {
    const snapshot = decodeSnapshot({
      sampledAt: 1,
      cpuUtilization: 0.5,
      cpuCount: 8,
      availableMemoryBytes: 2,
      totalMemoryBytes: 4,
    });

    expect(snapshot).not.toHaveProperty("storage");
    expect(snapshot).not.toHaveProperty("swap");
    expect(snapshot).not.toHaveProperty("gpu");
  });

  it("decodes machine details", () => {
    const snapshot = decodeSnapshot({
      sampledAt: 1,
      cpuUtilization: null,
      cpuCount: 8,
      availableMemoryBytes: 2,
      totalMemoryBytes: 4,
      cpuModel: "Apple M3 Max",
      loadAverage: { one: 1, five: 2, fifteen: 3 },
      swap: { totalBytes: 8, usedBytes: 1 },
      storage: {
        sampledAt: 1,
        volumes: [
          {
            mountPoint: "/",
            name: "disk",
            fileSystem: "ext4",
            totalBytes: 100,
            availableBytes: 40,
            roles: ["t3Home", "worktrees"],
          },
        ],
        unavailableReason: "Only T3 volumes are shown.",
      },
      cpuCoreUtilization: [0.25, 1],
      cpuCores: [
        { utilization: 0.25, user: 0.2, system: 0.05 },
        { utilization: 1, user: 0.7, system: 0.3 },
      ],
      memoryBreakdown: {
        kind: "darwin",
        appBytes: 2,
        wiredBytes: 1,
        compressedBytes: 0,
        availableBytes: 1,
      },
      memoryPressure: { level: "normal" },
      network: {
        sampledAt: 1,
        downloadBytesPerSecond: 1024,
        uploadBytesPerSecond: 512,
      },
      gpu: { gpus: [{ name: "Apple M3 Max", utilization: 0.09, memoryUsedBytes: 1024 }] },
    });

    expect(snapshot.storage?.volumes[0]?.roles).toEqual(["t3Home", "worktrees"]);
    expect(snapshot.cpuCores?.[0]?.user).toBe(0.2);
    expect(snapshot.memoryBreakdown?.kind).toBe("darwin");
    expect(snapshot.memoryPressure?.level).toBe("normal");
    expect(snapshot.network?.downloadBytesPerSecond).toBe(1024);
    expect(snapshot.gpu?.gpus[0]?.memoryTotalBytes).toBeUndefined();
    expect(() =>
      decodeSnapshot({ ...snapshot, gpu: { gpus: [{ name: "GPU", utilization: 37 }] } }),
    ).toThrow();
    expect(() =>
      decodeSnapshot({
        ...snapshot,
        cpuCores: [{ utilization: 0.5, user: 1.2, system: 0 }],
      }),
    ).toThrow();
  });
});

describe("ResourceMonitorEvent", () => {
  it("decodes the hello of a monitor without the host system capability", () => {
    const hello = decodeHello({
      version: 3,
      type: "hello",
      sidecarVersion: "0.1.0",
      sidecarPid: 1,
      platform: "linux",
      arch: "x86_64",
      capabilities: {
        cumulativeCpuTime: true,
        currentCpuPercent: true,
        residentMemory: true,
        virtualMemory: true,
        ioBytes: true,
        processStartTime: true,
        processTree: true,
      },
    });

    expect(hello.capabilities.hostSystem).toBeUndefined();
    expect(hello.capabilities.hostNetwork).toBeUndefined();
  });

  it("decodes a host system event", () => {
    const event = decodeMonitorEvent({
      version: 3,
      type: "hostSystem",
      requestId: "request",
      disks: [
        {
          mountPoint: "/",
          name: "disk",
          fileSystem: "apfs",
          totalBytes: 100,
          availableBytes: 40,
          removable: false,
          readOnly: true,
        },
      ],
      swapTotalBytes: 8,
      swapUsedBytes: 1,
      gpus: [{ name: "Apple M3 Max", utilizationPercent: 9, memoryUsedBytes: 1024 }],
    });

    expect(event.type).toBe("hostSystem");
    expect(event.type === "hostSystem" && event.gpus?.[0]?.utilizationPercent).toBe(9);
  });

  it("decodes a host network event", () => {
    const event = decodeMonitorEvent({
      version: 3,
      type: "hostNetwork",
      requestId: "net-1",
      sampledAtUnixMs: 1_700_000_000_000,
      receivedBytes: 4096,
      transmittedBytes: 2048,
      interfaceCount: 2,
    });

    expect(event.type).toBe("hostNetwork");
    expect(event.type === "hostNetwork" && event.receivedBytes).toBe(4096);
  });
});
