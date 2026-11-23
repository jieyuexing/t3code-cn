import { Tabs } from "@base-ui/react/tabs";
import {
  machineMemoryUsedShare,
  machineStorageState,
  machineVolumeLabel,
  machineVolumeTone,
  machineVolumeUsedShare,
} from "@t3tools/client-runtime/machine-resources";
import {
  appendMachineHistorySample,
  bucketMachineHistory,
  clearEnvironmentMachineHistory,
  getEnvironmentMachineHistory,
  recordEnvironmentMachineSample,
  subscribeEnvironmentMachineHistory,
  type MachineHistoryBucket,
  type MachineHistorySample,
} from "@t3tools/client-runtime/machine-resources-history-cn";
import type {
  BackgroundBooleanState,
  EnvironmentId,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowDownUpIcon,
  BatteryIcon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { formatBytes } from "~/lib/formatBytes";
import { useResourceTelemetry } from "~/lib/resourceTelemetryState";
import { cn } from "~/lib/utils";
import type { EnvironmentQueryView } from "~/state/query";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CoreStrip, GpuSection, MachineStat, UsageBar, VolumeRow } from "./MachineResourcesSection";
import {
  DetailRow,
  HISTORY_WINDOWS,
  HistoryWindowSelector,
  LastSampleLabel,
} from "./ResourceTelemetryDiagnostics";
import { resourceHistoryBarHeight } from "./ResourceTelemetryDiagnostics.logic";
import {
  computeMemorySegments,
  formatClockTimestamp,
  formatOneDecimalPercent,
  peakBucketMetric,
  pickPrimaryT3Volume,
  type MachineSubtab,
  type MemorySegmentDescriptor,
} from "./machineDiagnostics.logic.cn";

type GT = ReturnType<typeof useGT>;

interface PausedMachineState {
  readonly snapshot: HostResourcesSnapshot;
  readonly dataUpdatedAt: number;
  readonly samples: ReadonlyArray<MachineHistorySample>;
  readonly pausedAt: number;
}

interface ScopedMachineViewState {
  readonly environmentId: EnvironmentId;
  readonly tab: MachineSubtab;
  readonly selectedCoreIndex: number;
  readonly paused: PausedMachineState | null;
}

function formatByteRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function memorySegmentLabel(id: MemorySegmentDescriptor["id"], gt: GT): string {
  switch (id) {
    case "app":
      return gt("App memory");
    case "wired":
      return gt("Wired");
    case "compressed":
      return gt("Compressed");
    case "available":
      return gt("Available");
    case "kernel":
      return gt("Kernel");
    case "cached":
      return gt("Cached & reclaimable");
    case "free":
      return gt("Free");
  }
}

function pressureLevelLabel(
  level: NonNullable<HostResourcesSnapshot["memoryPressure"]>["level"],
  gt: GT,
): { readonly text: string; readonly className: string } | null {
  switch (level) {
    case "normal":
      return { text: gt("Normal"), className: "text-success-foreground" };
    case "warning":
      return { text: gt("Elevated"), className: "text-warning-foreground" };
    case "critical":
      return { text: gt("Critical"), className: "text-destructive" };
    case undefined:
      return null;
  }
}

function hostPowerValue(
  value: BackgroundBooleanState,
  labels: { readonly yes: string; readonly no: string; readonly unknown: string },
): string {
  if (value === "true") return labels.yes;
  if (value === "false") return labels.no;
  return labels.unknown;
}

function MachineLiveStatusBadge({
  isPaused,
  hasError,
}: {
  readonly isPaused: boolean;
  readonly hasError: boolean;
}) {
  const gt = useGT();
  const tone = isPaused ? "paused" : hasError ? "warning" : "live";
  return (
    <span
      data-testid="machine-status-badge"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-3xs font-semibold uppercase tracking-widest",
        tone === "live" && "border-success/25 bg-success/10 text-success-foreground",
        tone === "paused" && "border-warning/30 bg-warning/10 text-warning-foreground",
        tone === "warning" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "live" && "bg-success",
          tone === "paused" && "bg-warning",
          tone === "warning" && "bg-destructive",
        )}
      />
      {isPaused ? gt("Paused") : gt("Live")}
    </span>
  );
}

function ChartAxisRow({
  buckets,
  leftPrefix,
}: {
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly leftPrefix?: string | undefined;
}) {
  const first = buckets[0];
  const middle = buckets[Math.floor(buckets.length / 2)];
  const last = buckets.at(-1);
  if (!first || !middle || !last) return null;
  const startLabel = formatClockTimestamp(first.startedAt);
  return (
    <div className="mt-1.5 flex justify-between font-mono text-3xs tabular-nums text-muted-foreground/60">
      <span>{leftPrefix ? `${leftPrefix} · ${startLabel}` : startLabel}</span>
      <span>{formatClockTimestamp(middle.startedAt)}</span>
      <span>{formatClockTimestamp(last.endedAt)}</span>
    </div>
  );
}

function CpuHistoryChartCard({
  buckets,
  windowLabel,
  currentCpuUtilization,
  sampledAt,
}: {
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly windowLabel: string;
  readonly currentCpuUtilization: number | null;
  readonly sampledAt: number;
}) {
  const gt = useGT();
  const peakCpu = peakBucketMetric(buckets, (bucket) => bucket.maxCpuPercent);
  const hasSystemSeries = buckets.some((bucket) => bucket.avgCpuSystemPercent !== null);
  const scaleMax = Math.max(100, peakCpu ?? 0);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{gt("CPU history")}</span>
        <span className="font-mono text-3xs tabular-nums text-muted-foreground">
          {currentCpuUtilization === null
            ? gt("Unavailable")
            : [
                gt("Current {percent}%", {
                  percent: (currentCpuUtilization * 100).toFixed(1),
                }),
                peakCpu !== null
                  ? gt("{window} peak {percent}%", {
                      window: windowLabel,
                      percent: peakCpu.toFixed(1),
                    })
                  : null,
                formatClockTimestamp(sampledAt),
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-3xs text-muted-foreground/65">
        <span className="font-mono">100%</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full bg-primary/75" />
            <span>{gt("Total CPU")}</span>
          </span>
          {hasSystemSeries ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full bg-warning/80" />
              <span>{gt("System (kernel)")}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div
        data-testid="cpu-history-chart"
        className="flex h-28 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 p-2.5"
      >
        {buckets.map((bucket) => {
          if (bucket.sampleCount === 0 || bucket.avgCpuPercent === null) {
            return (
              <div key={bucket.startedAt} className="flex h-full min-w-1 flex-1 items-end">
                <span className="block h-px w-full bg-border/35" />
              </div>
            );
          }
          const totalHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: scaleMax,
            minimumVisiblePercent: 2,
          });
          const sysHeight =
            bucket.avgCpuSystemPercent === null
              ? 0
              : resourceHistoryBarHeight({
                  value: bucket.avgCpuSystemPercent,
                  max: scaleMax,
                  minimumVisiblePercent: 1,
                });
          return (
            <Tooltip key={bucket.startedAt}>
              <TooltipTrigger
                render={
                  <div
                    className={cn(
                      "grid h-full min-w-1 flex-1 items-end gap-px",
                      hasSystemSeries ? "grid-cols-2" : "grid-cols-1",
                    )}
                  >
                    <span
                      className="block rounded-t-xs bg-primary/75"
                      style={{ height: `${totalHeight}%` }}
                    />
                    {hasSystemSeries ? (
                      <span
                        className="block rounded-t-xs bg-warning/80"
                        style={{ height: `${sysHeight}%` }}
                      />
                    ) : null}
                  </div>
                }
              />
              <TooltipPopup side="top" className="text-left">
                <div className="space-y-0.5 font-mono text-3xs tabular-nums">
                  <div>{formatClockTimestamp(bucket.endedAt)}</div>
                  <div>
                    {gt("CPU avg {percent}%", { percent: bucket.avgCpuPercent.toFixed(1) })}
                  </div>
                  {bucket.maxCpuPercent !== null ? (
                    <div>
                      {gt("CPU peak {percent}%", { percent: bucket.maxCpuPercent.toFixed(1) })}
                    </div>
                  ) : null}
                  {bucket.avgCpuSystemPercent !== null ? (
                    <div>
                      {gt("System {percent}%", {
                        percent: bucket.avgCpuSystemPercent.toFixed(1),
                      })}
                    </div>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <ChartAxisRow buckets={buckets} leftPrefix="0%" />
    </div>
  );
}

function MemoryHistoryChartCard({
  buckets,
  windowLabel,
}: {
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly windowLabel: string;
}) {
  const gt = useGT();
  const peakMem = peakBucketMetric(buckets, (bucket) => bucket.maxMemoryUsedPercent);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-3xs text-muted-foreground/70">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-primary/70" />
          <span>{gt("Memory used history")}</span>
        </span>
        {peakMem !== null ? (
          <span className="font-mono tabular-nums">
            {gt("{window} peak {percent}%", { window: windowLabel, percent: peakMem.toFixed(1) })}
          </span>
        ) : null}
      </div>
      <div
        data-testid="memory-history-chart"
        className="flex h-28 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 p-2.5"
      >
        {buckets.map((bucket) => {
          if (bucket.sampleCount === 0 || bucket.avgMemoryUsedPercent === null) {
            return (
              <div key={bucket.startedAt} className="flex h-full min-w-1 flex-1 items-end">
                <span className="block h-px w-full bg-border/35" />
              </div>
            );
          }
          const barHeight = resourceHistoryBarHeight({
            value: bucket.avgMemoryUsedPercent,
            max: 100,
            minimumVisiblePercent: 2,
          });
          return (
            <Tooltip key={bucket.startedAt}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <span
                      className="block w-full rounded-t-xs bg-primary/70"
                      style={{ height: `${barHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="text-left">
                <div className="space-y-0.5 font-mono text-3xs tabular-nums">
                  <div>{formatClockTimestamp(bucket.endedAt)}</div>
                  <div>
                    {gt("Memory {percent}%", {
                      percent: bucket.avgMemoryUsedPercent.toFixed(1),
                    })}
                  </div>
                  {bucket.latestMemoryUsedBytes !== null ? (
                    <div>
                      {gt("{bytes} used", { bytes: formatBytes(bucket.latestMemoryUsedBytes) })}
                    </div>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <ChartAxisRow buckets={buckets} leftPrefix="0%" />
    </div>
  );
}

function NetworkHistoryChartCard({
  buckets,
  sampledAt,
}: {
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly sampledAt: number;
}) {
  const gt = useGT();
  const peakDown = peakBucketMetric(buckets, (bucket) => bucket.maxDownloadBytesPerSecond) ?? 0;
  const peakUp = peakBucketMetric(buckets, (bucket) => bucket.maxUploadBytesPerSecond) ?? 0;
  const scaleMax = Math.max(1024, peakDown, peakUp);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-3xs text-muted-foreground/65">
        <span className="font-mono tabular-nums">{formatByteRate(scaleMax)}</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full bg-info/75" />
            <span>{gt("Download")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full bg-warning/80" />
            <span>{gt("Upload")}</span>
          </span>
          <span className="font-mono tabular-nums">{formatClockTimestamp(sampledAt)}</span>
        </div>
      </div>
      <div
        data-testid="network-history-chart"
        className="flex h-28 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 p-2.5"
      >
        {buckets.map((bucket) => {
          if (
            bucket.sampleCount === 0 ||
            (bucket.avgDownloadBytesPerSecond === null && bucket.avgUploadBytesPerSecond === null)
          ) {
            return (
              <div key={bucket.startedAt} className="flex h-full min-w-1 flex-1 items-end">
                <span className="block h-px w-full bg-border/35" />
              </div>
            );
          }
          const downHeight = resourceHistoryBarHeight({
            value: bucket.avgDownloadBytesPerSecond ?? 0,
            max: scaleMax,
            minimumVisiblePercent: 2,
          });
          const upHeight = resourceHistoryBarHeight({
            value: bucket.avgUploadBytesPerSecond ?? 0,
            max: scaleMax,
            minimumVisiblePercent: 2,
          });
          return (
            <Tooltip key={bucket.startedAt}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-2 items-end gap-px">
                    <span
                      className="block rounded-t-xs bg-info/75"
                      style={{ height: `${downHeight}%` }}
                    />
                    <span
                      className="block rounded-t-xs bg-warning/80"
                      style={{ height: `${upHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="text-left">
                <div className="space-y-0.5 font-mono text-3xs tabular-nums">
                  <div>{formatClockTimestamp(bucket.endedAt)}</div>
                  {bucket.avgDownloadBytesPerSecond !== null ? (
                    <div>
                      {gt("Down {rate}", {
                        rate: formatByteRate(bucket.avgDownloadBytesPerSecond),
                      })}
                    </div>
                  ) : null}
                  {bucket.avgUploadBytesPerSecond !== null ? (
                    <div>
                      {gt("Up {rate}", { rate: formatByteRate(bucket.avgUploadBytesPerSecond) })}
                    </div>
                  ) : null}
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <ChartAxisRow buckets={buckets} leftPrefix="0 B/s" />
    </div>
  );
}

function OverviewSubtab({
  snapshot,
  buckets,
  windowLabel,
}: {
  readonly snapshot: HostResourcesSnapshot;
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly windowLabel: string;
}) {
  const gt = useGT();
  const cpuValue =
    snapshot.cpuUtilization === null
      ? gt("Unavailable")
      : formatOneDecimalPercent(snapshot.cpuUtilization);
  const cpuDetail = [
    gt("{count, plural, one {{count} logical core} other {{count} logical cores}}", {
      count: snapshot.cpuCount,
    }),
    snapshot.loadAverage
      ? gt("load {values}", {
          values: [
            snapshot.loadAverage.one,
            snapshot.loadAverage.five,
            snapshot.loadAverage.fifteen,
          ]
            .map((item) => item.toFixed(2))
            .join(" "),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hasMemory = snapshot.totalMemoryBytes > 0;
  const usedMemory = Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes);
  const memoryShare = machineMemoryUsedShare(snapshot);
  const memoryValue = hasMemory ? formatBytes(usedMemory) : gt("Unavailable");
  const memoryDetail = hasMemory
    ? [
        gt("{bytes} total", { bytes: formatBytes(snapshot.totalMemoryBytes) }),
        gt("{percent} used", { percent: formatOneDecimalPercent(memoryShare) }),
        gt("{bytes} available", { bytes: formatBytes(snapshot.availableMemoryBytes) }),
      ].join(" · ")
    : gt("Memory totals not reported by this server.");

  const { volume: primaryVolume, isT3Home } = pickPrimaryT3Volume(snapshot);
  const storageValue =
    primaryVolume !== null
      ? formatOneDecimalPercent(machineVolumeUsedShare(primaryVolume))
      : gt("Unavailable");
  const storageDetail =
    primaryVolume !== null
      ? gt("{free} free ({role} / {total} total)", {
          free: formatBytes(primaryVolume.availableBytes),
          role: isT3Home ? gt("T3 data") : machineVolumeLabel(primaryVolume),
          total: formatBytes(primaryVolume.totalBytes),
        })
      : (snapshot.storage?.unavailableReason ??
        (snapshot.storage === undefined
          ? gt("This server is too old to report disk usage. Update it to see its volumes.")
          : gt("No volumes reported.")));

  const network = snapshot.network;
  const peakDown = peakBucketMetric(buckets, (bucket) => bucket.maxDownloadBytesPerSecond);
  let networkValue: string;
  let networkDetail: string;
  if (network === undefined) {
    networkValue = gt("Unavailable");
    networkDetail = gt("Network throughput is not reported by this server.");
  } else if (network.unavailableReason !== undefined) {
    networkValue = gt("Unavailable");
    networkDetail = network.unavailableReason;
  } else if (
    network.warmingUp === true ||
    network.downloadBytesPerSecond === undefined ||
    network.uploadBytesPerSecond === undefined
  ) {
    networkValue = gt("Measuring…");
    networkDetail = gt("Waiting for the next sample to compute throughput");
  } else {
    networkValue = formatByteRate(network.downloadBytesPerSecond);
    networkDetail = [
      gt("Up {rate}", { rate: formatByteRate(network.uploadBytesPerSecond) }),
      peakDown !== null
        ? gt("{window} peak {rate}", { window: windowLabel, rate: formatByteRate(peakDown) })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <div>
      <div
        data-testid="machine-kpi-grid"
        className="grid grid-cols-2 border-b border-border/60 md:grid-cols-4"
      >
        <div
          data-testid="machine-kpi-cell"
          className="min-w-0 border-border/55 max-md:nth-[n+3]:border-t max-md:even:border-l md:not-first:border-l"
        >
          <MachineStat
            icon={<CpuIcon className="size-3.5" />}
            label="CPU"
            value={cpuValue}
            detail={cpuDetail}
          />
        </div>
        <div
          data-testid="machine-kpi-cell"
          className="min-w-0 border-border/55 max-md:nth-[n+3]:border-t max-md:even:border-l md:not-first:border-l"
        >
          <MachineStat
            icon={<MemoryStickIcon className="size-3.5" />}
            label={gt("Memory")}
            value={memoryValue}
            detail={memoryDetail}
          />
        </div>
        <div
          data-testid="machine-kpi-cell"
          className="min-w-0 border-border/55 max-md:nth-[n+3]:border-t max-md:even:border-l md:not-first:border-l"
        >
          <MachineStat
            icon={<HardDriveIcon className="size-3.5" />}
            label={gt("Storage")}
            value={storageValue}
            detail={storageDetail}
          />
        </div>
        <div
          data-testid="machine-kpi-cell"
          className="min-w-0 border-border/55 max-md:nth-[n+3]:border-t max-md:even:border-l md:not-first:border-l"
        >
          <MachineStat
            icon={<ArrowDownUpIcon className="size-3.5" />}
            label={gt("Network (down)")}
            value={networkValue}
            detail={networkDetail}
          />
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <CpuHistoryChartCard
          buckets={buckets}
          windowLabel={windowLabel}
          currentCpuUtilization={snapshot.cpuUtilization}
          sampledAt={snapshot.sampledAt}
        />
      </div>
    </div>
  );
}

function CpuAndMemorySubtab({
  snapshot,
  buckets,
  windowLabel,
  selectedCoreIndex,
  onSelectCore,
}: {
  readonly snapshot: HostResourcesSnapshot;
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly windowLabel: string;
  readonly selectedCoreIndex: number;
  readonly onSelectCore: (index: number) => void;
}) {
  const gt = useGT();
  const cores = snapshot.cpuCores;
  const clampedCoreIndex =
    cores && cores.length > 0 ? Math.min(selectedCoreIndex, cores.length - 1) : 0;
  const activeCore = cores?.[clampedCoreIndex];
  const memorySegments = computeMemorySegments(snapshot);
  const memoryShare = machineMemoryUsedShare(snapshot);
  const pressurePresentation = pressureLevelLabel(snapshot.memoryPressure?.level, gt);

  return (
    <div className="grid grid-cols-1 divide-y divide-border/60 md:grid-cols-[7fr_5fr] md:divide-x md:divide-y-0">
      <div className="min-w-0 px-4 py-4 sm:px-5">
        <CpuHistoryChartCard
          buckets={buckets}
          windowLabel={windowLabel}
          currentCpuUtilization={snapshot.cpuUtilization}
          sampledAt={snapshot.sampledAt}
        />

        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs font-semibold text-foreground">
              {gt("Logical cores · {count}", { count: snapshot.cpuCount })}
            </span>
            {cores && cores.length > 0 ? (
              <span className="text-3xs text-muted-foreground/70">
                {gt("Click a core to inspect user, system, and idle shares")}
              </span>
            ) : null}
          </div>

          {cores && cores.length > 0 ? (
            <>
              <div
                data-testid="machine-core-grid"
                className="mt-2 grid grid-cols-4 gap-1.5 md:grid-cols-8"
              >
                {cores.map((core, index) => {
                  const isSelected = index === clampedCoreIndex;
                  const coreNumber = String(index + 1).padStart(2, "0");
                  return (
                    <button
                      // oxlint-disable-next-line react/no-array-index-key -- logical cores are identified by index
                      key={index}
                      type="button"
                      data-testid="machine-core-cell"
                      aria-pressed={isSelected}
                      onClick={() => onSelectCore(index)}
                      className={cn(
                        "flex h-[38px] cursor-pointer flex-col justify-between rounded-md border px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected
                          ? "border-primary bg-primary/8"
                          : "border-border/70 bg-card hover:border-ring/50",
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-1 leading-none">
                        <span className="font-mono text-3xs text-muted-foreground">
                          {coreNumber}
                        </span>
                        <span className="font-mono text-2xs font-semibold tabular-nums text-foreground">
                          {Math.round(core.utilization * 100)}%
                        </span>
                      </div>
                      <div
                        className="flex h-1 w-full overflow-hidden rounded-full bg-muted"
                        aria-hidden
                      >
                        <span
                          className="h-full bg-primary"
                          style={{ width: `${Math.min(100, Math.max(0, core.user * 100))}%` }}
                        />
                        <span
                          className="h-full bg-warning"
                          style={{ width: `${Math.min(100, Math.max(0, core.system * 100))}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              {activeCore ? (
                <div
                  data-testid="machine-core-inspector"
                  className="mt-2.5 flex min-h-9 flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-2xs"
                >
                  <div>
                    <strong className="font-semibold text-foreground">
                      {gt("Core {number}", {
                        number: String(clampedCoreIndex + 1).padStart(2, "0"),
                      })}
                    </strong>
                    <span className="ml-2 font-mono tabular-nums text-muted-foreground">
                      {gt("Total {percent}%", {
                        percent: (activeCore.utilization * 100).toFixed(1),
                      })}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-xs bg-primary" />
                      <span>{gt("User")}</span>
                      <strong className="text-foreground">
                        {(activeCore.user * 100).toFixed(1)}%
                      </strong>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-xs bg-warning" />
                      <span>{gt("System", { $context: "CPU kernel share" })}</span>
                      <strong className="text-foreground">
                        {(activeCore.system * 100).toFixed(1)}%
                      </strong>
                    </span>
                    <span className="text-muted-foreground">
                      {gt("Idle {percent}%", {
                        percent: (Math.max(0, 1 - activeCore.utilization) * 100).toFixed(1),
                      })}
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          ) : snapshot.cpuCoreUtilization !== undefined ? (
            <div className="mt-2 space-y-2.5">
              <CoreStrip cores={snapshot.cpuCoreUtilization} />
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-3 py-2 text-2xs text-muted-foreground">
                {gt(
                  "This server only reports total per-core utilization; user and system shares are unavailable.",
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-dashed border-border/70 bg-muted/25 px-3 py-2.5 text-2xs text-muted-foreground">
              {gt("Per-core load not reported by this server")}
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 px-4 py-4 sm:px-5">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-foreground">{gt("Memory")}</span>
          <span className="font-mono text-3xs tabular-nums text-muted-foreground">
            {snapshot.totalMemoryBytes > 0
              ? `${formatOneDecimalPercent(memoryShare)} (${formatBytes(Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes))} / ${formatBytes(snapshot.totalMemoryBytes)})`
              : gt("Unavailable")}
          </span>
        </div>

        <MemoryHistoryChartCard buckets={buckets} windowLabel={windowLabel} />

        <div className="mt-4">
          <div className="flex items-center justify-between text-3xs font-semibold uppercase tracking-widest text-muted-foreground/75">
            <span>{gt("Memory composition")}</span>
            {snapshot.totalMemoryBytes > 0 ? (
              <span className="font-mono tabular-nums">
                {gt("{bytes} total", { bytes: formatBytes(snapshot.totalMemoryBytes) })}
              </span>
            ) : null}
          </div>

          {memorySegments.kind === "segments" ? (
            <>
              <div
                data-testid="memory-composition-bar"
                className="mt-2 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={gt("Memory composition")}
              >
                {memorySegments.segments.map((segment) => (
                  <div
                    key={segment.id}
                    className={cn("h-full", segment.barClassName)}
                    style={{ width: `${Math.max(0, segment.sharePercent)}%` }}
                  />
                ))}
              </div>
              <div className="mt-2.5 flex flex-col gap-1.5 text-2xs">
                {memorySegments.segments.map((segment) => (
                  <div key={segment.id} className="flex h-5 items-center justify-between gap-3">
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <span className={cn("size-2 shrink-0 rounded-xs", segment.dotClassName)} />
                      <span className="truncate">{memorySegmentLabel(segment.id, gt)}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      <strong className="font-semibold text-foreground">
                        {formatBytes(segment.bytes)}
                      </strong>
                      <span className="ml-1.5 text-muted-foreground">
                        {segment.sharePercent.toFixed(1)}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="mt-2 rounded-lg border border-dashed border-border/70 bg-muted/25 px-3 py-2.5 text-2xs text-muted-foreground">
              {memorySegments.reason ??
                gt("Memory composition breakdown is not reported by this server.")}
            </div>
          )}
        </div>

        <div className="mt-3 border-t border-border/55 pt-2">
          <DetailRow
            label={gt("Memory pressure")}
            value={
              pressurePresentation
                ? [
                    pressurePresentation.text,
                    snapshot.memoryPressure?.someAvg10 !== undefined
                      ? `PSI ${snapshot.memoryPressure.someAvg10.toFixed(1)}%`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : (snapshot.memoryPressure?.unavailableReason ??
                  gt("Memory pressure is not reported by this server."))
            }
            valueClassName={pressurePresentation?.className}
          />
          <DetailRow
            label={gt("Swap used")}
            value={
              snapshot.swap
                ? `${formatBytes(snapshot.swap.usedBytes)} / ${formatBytes(snapshot.swap.totalBytes)}`
                : gt("Swap is not reported by this server.")
            }
          />
        </div>
      </div>
    </div>
  );
}

function StorageSubtab({ snapshot }: { readonly snapshot: HostResourcesSnapshot }) {
  const gt = useGT();
  const storageState = machineStorageState(snapshot);
  const lowVolumes =
    storageState.kind === "volumes"
      ? storageState.volumes.filter((volume) => machineVolumeTone(volume) !== "default")
      : [];

  return (
    <div>
      {lowVolumes.length > 0 ? (
        <div className="space-y-1 border-b border-warning/30 bg-warning-surface px-4 py-2.5 text-xs text-warning-foreground sm:px-5">
          {lowVolumes.map((volume) => {
            const tone = machineVolumeTone(volume);
            return (
              <div key={volume.mountPoint} className="flex items-center gap-2">
                <AlertTriangleIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    tone === "danger" ? "text-destructive" : "text-warning",
                  )}
                />
                <span className={cn(tone === "danger" && "text-destructive")}>
                  {machineVolumeLabel(volume)} ·{" "}
                  {gt("Low disk space ({free} free)", {
                    free: formatBytes(volume.availableBytes),
                  })}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-4 pt-3 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70 sm:px-5">
        <span className="inline-flex items-center gap-2">
          <HardDriveIcon className="size-3.5 text-muted-foreground/55" />
          <span>{gt("Disks")}</span>
        </span>
      </div>

      {storageState.kind === "unsupported" ? (
        <p className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
          {gt("This server is too old to report disk usage. Update it to see its volumes.")}
        </p>
      ) : (
        <>
          {storageState.notice ? (
            <p className="flex items-start gap-1.5 px-4 pt-2 text-3xs text-muted-foreground sm:px-5">
              <AlertTriangleIcon className="mt-px size-3 shrink-0 text-warning" />
              {storageState.notice}
            </p>
          ) : null}
          {storageState.kind === "empty" ? (
            <p className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
              {gt("No volumes reported.")}
            </p>
          ) : (
            <ul className="divide-y divide-border/45">
              {storageState.volumes.map((volume) => (
                <VolumeRow key={volume.mountPoint} volume={volume} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function NetworkSubtab({
  snapshot,
  buckets,
  windowLabel,
}: {
  readonly snapshot: HostResourcesSnapshot;
  readonly buckets: ReadonlyArray<MachineHistoryBucket>;
  readonly windowLabel: string;
}) {
  const gt = useGT();
  const network = snapshot.network;
  const peakDown = peakBucketMetric(buckets, (bucket) => bucket.maxDownloadBytesPerSecond);
  const peakUp = peakBucketMetric(buckets, (bucket) => bucket.maxUploadBytesPerSecond);

  if (network === undefined) {
    return (
      <div className="px-4 py-5 sm:px-5">
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-4 text-xs text-muted-foreground">
          {gt("Network throughput is not reported by this server.")}
        </div>
      </div>
    );
  }

  if (network.unavailableReason !== undefined) {
    return (
      <div className="px-4 py-5 sm:px-5">
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-4 text-xs text-muted-foreground">
          {network.unavailableReason}
        </div>
      </div>
    );
  }

  const warmingUp =
    network.warmingUp === true ||
    network.downloadBytesPerSecond === undefined ||
    network.uploadBytesPerSecond === undefined;

  return (
    <div>
      <div className="grid grid-cols-1 divide-y divide-border/55 border-b border-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <MachineStat
          icon={<ArrowDownUpIcon className="size-3.5" />}
          label={gt("Download rate")}
          value={warmingUp ? gt("Measuring…") : formatByteRate(network.downloadBytesPerSecond ?? 0)}
          detail={
            warmingUp
              ? gt("Waiting for the next sample to compute throughput")
              : peakDown !== null
                ? gt("{window} peak {rate}", {
                    window: windowLabel,
                    rate: formatByteRate(peakDown),
                  })
                : undefined
          }
        />
        <MachineStat
          icon={<ArrowDownUpIcon className="size-3.5" />}
          label={gt("Upload rate")}
          value={warmingUp ? gt("Measuring…") : formatByteRate(network.uploadBytesPerSecond ?? 0)}
          detail={
            warmingUp
              ? gt("Throughput requires two consecutive interface counter samples")
              : peakUp !== null
                ? gt("{window} peak {rate}", { window: windowLabel, rate: formatByteRate(peakUp) })
                : undefined
          }
        />
      </div>

      <div className="px-4 py-4 sm:px-5">
        <NetworkHistoryChartCard buckets={buckets} sampledAt={snapshot.sampledAt} />
      </div>
    </div>
  );
}

function ProcessesSubtab() {
  const gt = useGT();
  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="rounded-lg border border-dashed border-primary/35 bg-primary/5 px-4 py-4 text-xs leading-relaxed text-foreground">
        <span className="font-medium">
          {gt(
            "Whole-machine processes are separate from the T3 process tree below; a whole-machine process table is not included yet.",
          )}
        </span>{" "}
        <span className="text-muted-foreground">
          {gt(
            "Inspect the Live process tree section below for T3 server, provider, terminal, and desktop child processes.",
          )}
        </span>
      </div>
    </div>
  );
}

function HardwareAndPowerSubtab({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HostResourcesSnapshot;
}) {
  const gt = useGT();
  const telemetry = useResourceTelemetry(environmentId);
  const power = telemetry.data?.power ?? null;
  const hasPowerSignals =
    power !== null &&
    (power.onBattery !== "unknown" ||
      power.lowPowerMode !== "unknown" ||
      power.idle !== "unknown" ||
      power.locked !== "unknown" ||
      power.thermalState !== "unknown");
  const unknownLabel = gt("Unknown");

  return (
    <div className="grid grid-cols-1 divide-y divide-border/60 md:grid-cols-2 md:divide-x md:divide-y-0">
      <div className="min-w-0">
        <div className="px-4 py-4 sm:px-5">
          <div className="mb-2 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
            <CpuIcon className="size-3.5 text-muted-foreground/55" />
            <span>{gt("Processor & load")}</span>
          </div>
          <DetailRow
            label={gt("CPU model")}
            value={snapshot.cpuModel ?? gt("Not reported by this server")}
          />
          <DetailRow label={gt("Logical cores")} value={String(snapshot.cpuCount)} />
          <DetailRow
            label={gt("Load average (1m / 5m / 15m)")}
            value={
              snapshot.loadAverage
                ? `${snapshot.loadAverage.one.toFixed(2)} / ${snapshot.loadAverage.five.toFixed(2)} / ${snapshot.loadAverage.fifteen.toFixed(2)}`
                : gt("Unavailable on this platform")
            }
          />
          {snapshot.cpuUtilization !== null ? (
            <div className="mt-2.5">
              <UsageBar share={snapshot.cpuUtilization} />
            </div>
          ) : null}
        </div>
        <GpuSection snapshot={snapshot} />
      </div>

      <div className="min-w-0 px-4 py-4 sm:px-5">
        <div className="mb-2 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
          <BatteryIcon className="size-3.5 text-muted-foreground/55" />
          <span>{gt("Power & thermal state")}</span>
        </div>
        {hasPowerSignals && power ? (
          <>
            <DetailRow
              label={gt("Power source")}
              value={hostPowerValue(power.onBattery, {
                yes: gt("Battery"),
                no: gt("External power"),
                unknown: unknownLabel,
              })}
            />
            <DetailRow
              label={gt("Low power mode")}
              value={hostPowerValue(power.lowPowerMode, {
                yes: gt("Enabled"),
                no: gt("Disabled"),
                unknown: unknownLabel,
              })}
            />
            <DetailRow
              label={gt("Idle")}
              value={`${hostPowerValue(power.idle, {
                yes: gt("Idle", { $context: "host power state" }),
                no: gt("Active", { $context: "host power state" }),
                unknown: unknownLabel,
              })}${power.idleSeconds === null ? "" : ` · ${Math.round(power.idleSeconds)}s`}`}
            />
            <DetailRow
              label={gt("Session")}
              value={
                power.suspended
                  ? gt("Suspended")
                  : hostPowerValue(power.locked, {
                      yes: gt("Locked"),
                      no: gt("Unlocked"),
                      unknown: unknownLabel,
                    })
              }
            />
            <DetailRow
              label={gt("Thermal")}
              value={power.thermalState}
              valueClassName={
                power.thermalState === "serious" || power.thermalState === "critical"
                  ? "text-destructive"
                  : undefined
              }
            />
          </>
        ) : (
          <div className="mt-2 rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-4">
            <div className="text-xs font-medium text-foreground">
              {gt("Desktop host signals not connected")}
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground/75">
              {gt(
                "Power, idle, lock, and thermal state are supplied by the desktop host. Machine telemetry remains active in this browser session.",
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export function useMachineDiagnostics({
  environmentId,
  canRead,
  query,
}: {
  readonly environmentId: EnvironmentId;
  readonly canRead: boolean;
  readonly query: EnvironmentQueryView<HostResourcesSnapshot>;
}): {
  readonly headerAction: ReactNode;
  readonly content: ReactNode;
} {
  const gt = useGT();
  const [windowMs, setWindowMs] = useState<number>(15 * 60_000);
  const [scopedState, setScopedState] = useState<ScopedMachineViewState>(() => ({
    environmentId,
    tab: "overview",
    selectedCoreIndex: 0,
    paused: null,
  }));

  const currentView: ScopedMachineViewState =
    scopedState.environmentId === environmentId
      ? scopedState
      : {
          environmentId,
          tab: "overview",
          selectedCoreIndex: 0,
          paused: null,
        };

  const liveSamples = useSyncExternalStore(
    (listener) => subscribeEnvironmentMachineHistory(environmentId, listener),
    () => getEnvironmentMachineHistory(environmentId),
    () => getEnvironmentMachineHistory(environmentId),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors incoming machineResources poll samples into the external bounded ring buffer while mounted, including while the UI view is paused
  useEffect(() => {
    if (!canRead || !query.data) return;
    recordEnvironmentMachineSample(environmentId, query.data);
  }, [canRead, environmentId, query.data]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the in-memory ring buffer for this environment when the diagnostics section unmounts or switches environment
  useEffect(() => {
    return () => {
      clearEnvironmentMachineHistory(environmentId);
    };
  }, [environmentId]);

  const effectiveLiveSamples =
    liveSamples.length > 0 || !query.data
      ? liveSamples
      : appendMachineHistorySample(liveSamples, query.data);

  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];

  const isPaused = currentView.paused !== null;
  const activeSnapshot = currentView.paused ? currentView.paused.snapshot : query.data;
  const activeDataUpdatedAt = currentView.paused
    ? currentView.paused.dataUpdatedAt
    : query.dataUpdatedAt;
  const activeSamples = currentView.paused ? currentView.paused.samples : effectiveLiveSamples;
  const anchorMs = currentView.paused
    ? currentView.paused.pausedAt
    : (activeSnapshot?.sampledAt ?? 0);

  const buckets =
    activeSnapshot !== null
      ? bucketMachineHistory(activeSamples, {
          windowMs: selectedWindow.windowMs,
          bucketMs: selectedWindow.bucketMs,
          anchorMs,
        })
      : [];

  const togglePause = () => {
    if (currentView.paused !== null) {
      setScopedState({
        ...currentView,
        environmentId,
        paused: null,
      });
      return;
    }
    if (!query.data) return;
    setScopedState({
      ...currentView,
      environmentId,
      paused: {
        snapshot: query.data,
        dataUpdatedAt: query.dataUpdatedAt,
        samples: effectiveLiveSamples,
        pausedAt: query.data.sampledAt,
      },
    });
  };

  const sampledAtUtc =
    !isPaused && activeSnapshot ? DateTime.makeUnsafe(activeSnapshot.sampledAt) : null;

  const headerAction = (
    <div className="flex flex-wrap items-center gap-2">
      {activeSnapshot ? (
        <MachineLiveStatusBadge isPaused={isPaused} hasError={Boolean(query.error)} />
      ) : null}
      {isPaused && currentView.paused ? (
        <span className="font-mono text-2xs tabular-nums text-muted-foreground/70">
          {gt("Paused at {time}", {
            time: formatClockTimestamp(currentView.paused.pausedAt),
          })}
        </span>
      ) : (
        <LastSampleLabel sampledAt={sampledAtUtc} />
      )}
      <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
      <Button
        size="xs"
        variant="outline"
        disabled={!activeSnapshot}
        onClick={togglePause}
        data-testid="machine-pause-toggle"
      >
        {isPaused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
        <span>{isPaused ? gt("Resume") : gt("Pause")}</span>
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={query.isPending}
              onClick={query.refresh}
              aria-label={gt("Refresh machine resources")}
            >
              <RefreshIcon size="xs" refreshing={query.isPending} />
            </Button>
          }
        />
        <TooltipPopup side="top">{gt("Refresh machine resources")}</TooltipPopup>
      </Tooltip>
    </div>
  );

  const subtabs: ReadonlyArray<{ readonly id: MachineSubtab; readonly label: string }> = [
    { id: "overview", label: gt("Overview") },
    { id: "cpu-memory", label: gt("CPU & memory") },
    { id: "storage", label: gt("Storage") },
    { id: "network", label: gt("Network") },
    { id: "processes", label: gt("Processes") },
    { id: "hardware", label: gt("Hardware & power") },
  ];

  const content = !activeSnapshot ? (
    <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
      {query.error ?? gt("Reading machine resources…")}
    </div>
  ) : (
    <div className="overflow-hidden rounded-[inherit]">
      <Tabs.Root
        value={currentView.tab}
        onValueChange={(nextValue) => {
          setScopedState({
            ...currentView,
            environmentId,
            tab: nextValue as MachineSubtab,
          });
        }}
      >
        <Tabs.List
          data-testid="machine-subtab-bar"
          aria-label={gt("Machine resource views")}
          className="flex h-9 items-center gap-1 overflow-x-auto border-b border-border/60 bg-muted/45 px-4 sm:px-5"
        >
          {subtabs.map((tab) => (
            <Tabs.Tab
              key={tab.id}
              value={tab.id}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:border-primary aria-selected:font-semibold aria-selected:text-foreground"
            >
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>

        {isPaused && currentView.paused ? (
          <div
            data-testid="machine-paused-banner"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-warning-surface px-4 py-2 text-xs text-warning-foreground sm:px-5"
          >
            <span>
              {gt(
                "Live view paused at {time}. Background sampling continues within the bounded window.",
                { time: formatClockTimestamp(currentView.paused.pausedAt) },
              )}
            </span>
            <Button size="xs" variant="outline" onClick={togglePause}>
              {gt("Resume")}
            </Button>
          </div>
        ) : null}

        {query.error && !isPaused ? (
          <p
            role="status"
            className="border-b border-border/60 px-4 py-2.5 text-xs text-warning-foreground sm:px-5"
          >
            {query.error}{" "}
            <time dateTime={new Date(activeDataUpdatedAt).toISOString()}>
              {new Date(activeDataUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
        ) : null}

        <Tabs.Panel value="overview">
          <OverviewSubtab
            snapshot={activeSnapshot}
            buckets={buckets}
            windowLabel={selectedWindow.label}
          />
        </Tabs.Panel>
        <Tabs.Panel value="cpu-memory">
          <CpuAndMemorySubtab
            snapshot={activeSnapshot}
            buckets={buckets}
            windowLabel={selectedWindow.label}
            selectedCoreIndex={currentView.selectedCoreIndex}
            onSelectCore={(index) => {
              setScopedState({
                ...currentView,
                environmentId,
                selectedCoreIndex: index,
              });
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="storage">
          <StorageSubtab snapshot={activeSnapshot} />
        </Tabs.Panel>
        <Tabs.Panel value="network">
          <NetworkSubtab
            snapshot={activeSnapshot}
            buckets={buckets}
            windowLabel={selectedWindow.label}
          />
        </Tabs.Panel>
        <Tabs.Panel value="processes">
          <ProcessesSubtab />
        </Tabs.Panel>
        <Tabs.Panel value="hardware">
          <HardwareAndPowerSubtab environmentId={environmentId} snapshot={activeSnapshot} />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );

  return { headerAction, content };
}
