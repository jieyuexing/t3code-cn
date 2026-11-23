import type * as NodeOS from "node:os";
import type {
  HostCpuCore,
  HostMemoryBreakdown,
  HostMemoryPressure,
  HostNetwork,
  HostResourcesSnapshot,
  ResourceMonitorHostNetworkEvent,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

const MIN_NETWORK_WINDOW_MS = 250;
const MAX_NETWORK_BASELINE_AGE_MS = 30_000;

export interface NetworkCounterSample {
  readonly sampledAtUnixMs: number;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
  readonly interfaceCount: number;
  readonly unavailableReason?: string;
}

export interface NetworkRateState {
  readonly baseline: NetworkCounterSample | null;
  readonly lastReading: HostNetwork | null;
}

export const INITIAL_NETWORK_RATE_STATE: NetworkRateState = {
  baseline: null,
  lastReading: null,
};

const cpuTotal = ({ times }: NodeOS.CpuInfo) =>
  times.user + times.nice + times.sys + times.idle + times.irq;

// Activity Monitor and procps group nice with user time and irq/softirq with kernel time.
export function coreBreakdown(
  before: ReadonlyArray<NodeOS.CpuInfo>,
  after: ReadonlyArray<NodeOS.CpuInfo>,
): ReadonlyArray<HostCpuCore> | undefined {
  if (before.length === 0 || before.length !== after.length) return undefined;
  return after.map((info, index) => {
    const previous = before[index] ?? info;
    const total = cpuTotal(info) - cpuTotal(previous);
    const idle = info.times.idle - previous.times.idle;
    if (total <= 0 || idle < 0) return { utilization: 0, user: 0, system: 0 };
    const utilization = Math.min(1, Math.max(0, 1 - idle / total));
    const rawUser =
      Math.max(0, info.times.user - previous.times.user) +
      Math.max(0, info.times.nice - previous.times.nice);
    const rawSystem =
      Math.max(0, info.times.sys - previous.times.sys) +
      Math.max(0, info.times.irq - previous.times.irq);
    const user = Math.min(utilization, Math.max(0, rawUser / total));
    const system = Math.min(Math.max(0, utilization - user), Math.max(0, rawSystem / total));
    return { utilization, user, system };
  });
}

function vmStatPages(output: string, label: string): number | null {
  const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(output)?.[1];
  return match === undefined ? null : Number(match);
}

// Matches macOS Activity Monitor: App = Anonymous - Purgeable, Wired = Pages wired down,
// Compressed = Pages occupied by compressor, Available = Physical Memory - Memory Used.
export function parseDarwinMemoryBreakdown(
  vmStatOutput: string,
  totalMemoryBytes: number,
): HostMemoryBreakdown {
  const pageSizeRaw = /page size of (\d+) bytes/.exec(vmStatOutput)?.[1];
  const pageSize = pageSizeRaw === undefined ? 0 : Number(pageSizeRaw);
  const anonymous = vmStatPages(vmStatOutput, "Anonymous pages");
  const purgeable = vmStatPages(vmStatOutput, "Pages purgeable");
  const wired = vmStatPages(vmStatOutput, "Pages wired down");
  const compressed = vmStatPages(vmStatOutput, "Pages occupied by compressor");
  if (
    pageSize <= 0 ||
    !Number.isSafeInteger(totalMemoryBytes) ||
    totalMemoryBytes <= 0 ||
    anonymous === null ||
    purgeable === null ||
    wired === null ||
    compressed === null
  ) {
    return {
      kind: "unavailable",
      unavailableReason: "macOS vm_stat output did not include full memory breakdown counters.",
    };
  }
  const wiredBytes = Math.min(totalMemoryBytes, wired * pageSize);
  const compressedBytes = Math.min(totalMemoryBytes - wiredBytes, compressed * pageSize);
  const appBytes = Math.min(
    totalMemoryBytes - wiredBytes - compressedBytes,
    Math.max(0, anonymous - purgeable) * pageSize,
  );
  const availableBytes = Math.max(0, totalMemoryBytes - appBytes - wiredBytes - compressedBytes);
  return { kind: "darwin", appBytes, wiredBytes, compressedBytes, availableBytes };
}

function meminfoKilobytes(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo)?.[1];
  return match === undefined ? null : Number(match);
}

// Linux Cached includes Shmem/tmpfs; move Shmem to appBytes so cachedBytes holds only
// reclaimable file/metadata cache (Buffers + Cached - Shmem + KReclaimable/SReclaimable).
export function parseLinuxMemoryBreakdown(
  meminfo: string,
  options?: { readonly cgroupCapped?: boolean },
): HostMemoryBreakdown {
  if (options?.cgroupCapped) {
    return {
      kind: "unavailable",
      unavailableReason:
        "Host /proc/meminfo breakdown is omitted when cgroup memory.max caps the container.",
    };
  }
  const totalKb = meminfoKilobytes(meminfo, "MemTotal");
  const freeKb = meminfoKilobytes(meminfo, "MemFree");
  const buffersKb = meminfoKilobytes(meminfo, "Buffers");
  const cachedKb = meminfoKilobytes(meminfo, "Cached");
  const anonKb = meminfoKilobytes(meminfo, "AnonPages");
  const reclaimableSlabKb =
    meminfoKilobytes(meminfo, "KReclaimable") ?? meminfoKilobytes(meminfo, "SReclaimable");
  const shmemKb = meminfoKilobytes(meminfo, "Shmem") ?? 0;
  if (
    totalKb === null ||
    totalKb <= 0 ||
    freeKb === null ||
    buffersKb === null ||
    cachedKb === null ||
    anonKb === null ||
    reclaimableSlabKb === null
  ) {
    return {
      kind: "unavailable",
      unavailableReason: "Linux /proc/meminfo did not include full memory breakdown counters.",
    };
  }
  const totalBytes = totalKb * 1024;
  const appBytes = Math.min(totalBytes, (anonKb + shmemKb) * 1024);
  const cachedBytes = Math.min(
    totalBytes - appBytes,
    (buffersKb + Math.max(0, cachedKb - shmemKb) + reclaimableSlabKb) * 1024,
  );
  const freeBytes = Math.min(totalBytes - appBytes - cachedBytes, freeKb * 1024);
  const kernelBytes = Math.max(0, totalBytes - appBytes - cachedBytes - freeBytes);
  return { kind: "linux", appBytes, kernelBytes, cachedBytes, freeBytes };
}

// XNU bsd/sys/kern_memorystatus.h: kVMPressureNormal=1, kVMPressureWarning=2, kVMPressureCritical=4.
export function parseDarwinMemoryPressure(sysctlOutput: string): HostMemoryPressure {
  const trimmed = sysctlOutput.trim();
  if (trimmed === "1") return { level: "normal" };
  if (trimmed === "2") return { level: "warning" };
  if (trimmed === "4") return { level: "critical" };
  return {
    unavailableReason: "macOS kern.memorystatus_vm_pressure_level was unavailable or unrecognized.",
  };
}

// PSI 10s stall shares: critical when all tasks stall >=5% or some >=30%; warning at full >=1% or some >=10%.
export function parseLinuxMemoryPressure(psiOutput: string): HostMemoryPressure {
  const someRaw = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(psiOutput)?.[1];
  const fullRaw = /^full\s+avg10=(\d+(?:\.\d+)?)/m.exec(psiOutput)?.[1];
  if (someRaw === undefined || fullRaw === undefined) {
    return { unavailableReason: "Linux memory PSI (/proc/pressure/memory) is unavailable." };
  }
  const someAvg10 = Number(someRaw);
  const fullAvg10 = Number(fullRaw);
  if (
    !Number.isFinite(someAvg10) ||
    !Number.isFinite(fullAvg10) ||
    someAvg10 < 0 ||
    fullAvg10 < 0
  ) {
    return { unavailableReason: "Linux memory PSI (/proc/pressure/memory) was malformed." };
  }
  const level =
    fullAvg10 >= 5 || someAvg10 >= 30
      ? ("critical" as const)
      : fullAvg10 >= 1 || someAvg10 >= 10
        ? ("warning" as const)
        : ("normal" as const);
  return { level, someAvg10, fullAvg10 };
}

export function advanceNetworkRateState(
  state: NetworkRateState,
  sample: Pick<
    ResourceMonitorHostNetworkEvent,
    | "sampledAtUnixMs"
    | "receivedBytes"
    | "transmittedBytes"
    | "interfaceCount"
    | "unavailableReason"
  >,
): { readonly state: NetworkRateState; readonly reading: HostNetwork } {
  if (sample.unavailableReason !== undefined || sample.interfaceCount === 0) {
    return {
      state: INITIAL_NETWORK_RATE_STATE,
      reading: {
        sampledAt: sample.sampledAtUnixMs,
        unavailableReason:
          sample.unavailableReason ?? "No active non-loopback network interfaces found.",
      },
    };
  }
  const current: NetworkCounterSample = {
    sampledAtUnixMs: sample.sampledAtUnixMs,
    receivedBytes: sample.receivedBytes,
    transmittedBytes: sample.transmittedBytes,
    interfaceCount: sample.interfaceCount,
  };
  const previous = state.baseline;
  if (previous === null) {
    const reading: HostNetwork = {
      sampledAt: current.sampledAtUnixMs,
      warmingUp: true,
      unavailableReason: "Warming up network counters; waiting for the next sample.",
    };
    return { state: { baseline: current, lastReading: null }, reading };
  }

  const elapsedMs = current.sampledAtUnixMs - previous.sampledAtUnixMs;
  if (elapsedMs < 0 || elapsedMs > MAX_NETWORK_BASELINE_AGE_MS) {
    const reading: HostNetwork = {
      sampledAt: current.sampledAtUnixMs,
      warmingUp: true,
      unavailableReason: "Warming up network counters; waiting for the next sample.",
    };
    return { state: { baseline: current, lastReading: null }, reading };
  }
  if (
    current.receivedBytes < previous.receivedBytes ||
    current.transmittedBytes < previous.transmittedBytes
  ) {
    const reading: HostNetwork = {
      sampledAt: current.sampledAtUnixMs,
      warmingUp: true,
      unavailableReason: "Network interface counters reset; warming up.",
    };
    return { state: { baseline: current, lastReading: null }, reading };
  }
  if (elapsedMs < MIN_NETWORK_WINDOW_MS) {
    if (state.lastReading !== null) {
      return { state, reading: state.lastReading };
    }
    return {
      state,
      reading: {
        sampledAt: current.sampledAtUnixMs,
        warmingUp: true,
        unavailableReason: "Warming up network counters; waiting for the next sample.",
      },
    };
  }

  const downloadBytesPerSecond =
    ((current.receivedBytes - previous.receivedBytes) * 1_000) / elapsedMs;
  const uploadBytesPerSecond =
    ((current.transmittedBytes - previous.transmittedBytes) * 1_000) / elapsedMs;
  const reading: HostNetwork = {
    sampledAt: current.sampledAtUnixMs,
    downloadBytesPerSecond,
    uploadBytesPerSecond,
  };
  return { state: { baseline: current, lastReading: reading }, reading };
}

export function sampleMachineDimensions(input: {
  readonly platform: NodeJS.Platform;
  readonly beforeCores: ReadonlyArray<NodeOS.CpuInfo>;
  readonly afterCores: ReadonlyArray<NodeOS.CpuInfo>;
  readonly totalMemoryBytes: number;
  readonly vmStatOutput: string;
  readonly meminfo: string;
  readonly cgroupMemoryCapped: boolean;
}): Pick<HostResourcesSnapshot, "cpuCores" | "memoryBreakdown"> {
  const cpuCores = coreBreakdown(input.beforeCores, input.afterCores);
  const memoryBreakdown: HostMemoryBreakdown =
    input.platform === "darwin"
      ? parseDarwinMemoryBreakdown(input.vmStatOutput, input.totalMemoryBytes)
      : input.platform === "linux"
        ? parseLinuxMemoryBreakdown(input.meminfo, { cgroupCapped: input.cgroupMemoryCapped })
        : {
            kind: "unavailable",
            unavailableReason: `Memory breakdown is not supported on ${input.platform}.`,
          };
  return {
    ...(cpuCores ? { cpuCores } : {}),
    memoryBreakdown,
  };
}

export const makeMachineDimensions = Effect.fn("MachineDimensions.make")(function* (deps: {
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string) => Effect.Effect<string>;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const initNative = yield* Effect.serviceOption(NativeTelemetryClient.NativeTelemetryClient);
  const networkState = yield* Ref.make(INITIAL_NETWORK_RATE_STATE);
  const networkLock = yield* Semaphore.make(1);

  const samplePressure = Effect.fn("MachineDimensions.samplePressure")(function* () {
    if (deps.platform === "darwin") {
      const output = yield* deps.spawner
        .string(
          ChildProcess.make("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      return parseDarwinMemoryPressure(output);
    }
    if (deps.platform === "linux") {
      return parseLinuxMemoryPressure(yield* deps.readFile("/proc/pressure/memory"));
    }
    return {
      unavailableReason: `Memory pressure level is not supported on ${deps.platform}.`,
    } satisfies HostMemoryPressure;
  });

  const pressureCache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "pressure") => samplePressure(),
    timeToLive: "5 seconds",
  });

  const readNetwork = Effect.fn("MachineDimensions.readNetwork")(function* () {
    const callNative = yield* Effect.serviceOption(NativeTelemetryClient.NativeTelemetryClient);
    const native = Option.orElse(callNative, () => initNative);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (Option.isNone(native)) {
      return {
        sampledAt: now,
        unavailableReason: "Native resource monitor is unavailable.",
      } satisfies HostNetwork;
    }
    return yield* networkLock.withPermits(1)(
      native.value.hostNetwork.pipe(
        Effect.flatMap((event) =>
          Ref.modify(networkState, (current) => {
            const next = advanceNetworkRateState(current, event);
            return [next.reading, next.state] as const;
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            sampledAt: now,
            unavailableReason: error.message,
          } satisfies HostNetwork),
        ),
      ),
    );
  });

  const readExtra = Effect.all(
    {
      memoryPressure: Cache.get(pressureCache, "pressure"),
      network: readNetwork(),
    },
    { concurrency: 2 },
  );

  return { readExtra };
});
