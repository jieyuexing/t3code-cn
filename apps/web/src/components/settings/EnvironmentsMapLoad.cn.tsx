import { Link } from "@tanstack/react-router";
import { machineSummaryParts } from "@t3tools/client-runtime/machine-resources";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { ActivityIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { FleetEnvironmentNode } from "./environmentsMap.logic";
import {
  evaluateEnvironmentLoad,
  formatCompactDiskBadgeValue,
  formatCompactLoadMemory,
  type EnvironmentLoadUnavailableReason,
} from "./environmentsMapLoad.logic.cn";

type GT = ReturnType<typeof useGT>;

function unavailableLoadLabel(
  reason: EnvironmentLoadUnavailableReason,
  errorMessage: string | undefined,
  gt: GT,
): string {
  switch (reason) {
    case "off":
      return gt("Switched off · load unavailable");
    case "connecting":
      return gt("Connecting · load unavailable");
    case "disconnected":
      return gt("Not connected · load unavailable");
    case "forbidden":
      return gt("No permission to read load");
    case "error":
      return errorMessage ?? gt("Could not read load");
    case "unsupported":
      return gt("Server did not report load");
  }
}

export function EnvironmentsMapLoadToggle({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2 text-xs font-medium text-foreground select-none">
            <span>{gt("Show load")}</span>
            <Switch
              size="sm"
              checked={checked}
              aria-label={gt("Show load")}
              onCheckedChange={(next) => onCheckedChange(Boolean(next))}
            />
          </label>
        }
      />
      <TooltipPopup>
        {gt("Poll CPU, available memory, and warnings for connected environments")}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Compact load overlay rendered inside a visible environment card when the map load toggle is on.
 * Mounts the machineResources query only for connected environments with read permission.
 */
export function EnvironmentNodeLoadRow({
  node,
  environment,
}: {
  readonly node: FleetEnvironmentNode;
  readonly environment: EnvironmentPresentation | undefined;
}) {
  const gt = useGT();
  const enabled = environment?.entry.enabled ?? node.enabled;
  if (!enabled || node.phase !== "connected") {
    const reason: EnvironmentLoadUnavailableReason = !enabled
      ? "off"
      : node.phase === "connecting" || node.phase === "reconnecting"
        ? "connecting"
        : "disconnected";
    return (
      <LoadRowFrame>
        <span className="truncate">{unavailableLoadLabel(reason, undefined, gt)}</span>
      </LoadRowFrame>
    );
  }
  return <ScopedEnvironmentNodeLoadRow environmentId={node.environmentId} enabled={enabled} />;
}

function ScopedEnvironmentNodeLoadRow({
  environmentId,
  enabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) {
    return (
      <LoadRowFrame>
        <span className="truncate">{unavailableLoadLabel("forbidden", undefined, gt)}</span>
      </LoadRowFrame>
    );
  }
  return <ConnectedEnvironmentNodeLoadRow environmentId={environmentId} enabled={enabled} />;
}

function ConnectedEnvironmentNodeLoadRow({
  environmentId,
  enabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    serverEnvironment.machineResources({ environmentId, input: {} }),
  );
  const state = evaluateEnvironmentLoad(query.data, {
    connected: true,
    enabled,
    canRead: true,
    isPending: query.isPending,
    error: query.error,
  });

  if (state.kind === "loading") {
    return (
      <LoadRowFrame>
        <span className="truncate text-muted-foreground/75">{gt("Reading load…")}</span>
      </LoadRowFrame>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <LoadRowFrame>
        <span className="truncate">
          {unavailableLoadLabel(state.reason, state.errorMessage, gt)}
        </span>
      </LoadRowFrame>
    );
  }

  const metricParts: string[] = [];
  if (state.cpuPercent !== null) {
    metricParts.push(gt("CPU {percent}%", { percent: state.cpuPercent }));
  }
  if (state.availableMemoryBytes !== null) {
    metricParts.push(
      gt("{bytes} avail", { bytes: formatCompactLoadMemory(state.availableMemoryBytes) }),
    );
  }
  const metricsText = metricParts.join(" · ");

  return (
    <LoadRowFrame tone={state.tone}>
      <span
        className={cn(
          "min-w-0 truncate font-mono tabular-nums",
          state.tone !== "default" && "font-medium text-foreground",
        )}
      >
        {metricsText}
      </span>
      {state.memoryPressureHigh || state.diskWarning !== null ? (
        <span className="flex shrink-0 items-center gap-0.5">
          {state.memoryPressureHigh ? (
            <span className="inline-flex items-center rounded-sm bg-warning-surface px-1 py-px text-3xs leading-tight font-semibold text-warning-foreground">
              {gt("Mem high")}
            </span>
          ) : null}
          {state.diskWarning !== null ? (
            <span
              className={cn(
                "inline-flex items-center rounded-sm px-1 py-px text-3xs leading-tight font-semibold",
                state.diskWarning.tone === "danger"
                  ? "bg-error-surface text-destructive"
                  : "bg-warning-surface text-warning-foreground",
              )}
            >
              {gt("Disk {free}", {
                free: formatCompactDiskBadgeValue(state.diskWarning.availableBytes),
              })}
            </span>
          ) : null}
        </span>
      ) : null}
    </LoadRowFrame>
  );
}

function LoadRowFrame({
  tone,
  children,
}: {
  readonly tone?: "default" | "warning" | "danger";
  readonly children: React.ReactNode;
}) {
  return (
    <span
      data-load-tone={tone}
      className="mt-0.5 flex w-full min-w-0 items-center justify-between gap-1 border-t border-border/65 pt-1 text-3xs leading-3.5 text-muted-foreground"
    >
      {children}
    </span>
  );
}

/**
 * Selected environment machine summary and diagnostics shortcut in FleetDetails.
 * Independent of the map toolbar toggle: only mounts its query while details are visible.
 */
export function EnvironmentNodeDiagnosticsBar({
  environmentId,
  connected,
  hasInlineSummary,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly hasInlineSummary: boolean;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">
        {!connected ? (
          <span>{gt("Not connected, so machine load cannot be read.")}</span>
        ) : (
          <ScopedNodeDiagnosticsSummary
            environmentId={environmentId}
            hasInlineSummary={hasInlineSummary}
          />
        )}
      </div>
      <Button
        size="xs"
        variant="outline"
        render={<Link to="/settings/diagnostics" search={{ machine: environmentId }} />}
      >
        <ActivityIcon aria-hidden className="size-3.5" />
        {gt("Open diagnostics")}
      </Button>
    </div>
  );
}

function ScopedNodeDiagnosticsSummary({
  environmentId,
  hasInlineSummary,
}: {
  readonly environmentId: EnvironmentId;
  readonly hasInlineSummary: boolean;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) {
    return <span>{gt("This session may not read machine resources.")}</span>;
  }
  return (
    <ConnectedNodeDiagnosticsSummary
      environmentId={environmentId}
      hasInlineSummary={hasInlineSummary}
    />
  );
}

function ConnectedNodeDiagnosticsSummary({
  environmentId,
  hasInlineSummary,
}: {
  readonly environmentId: EnvironmentId;
  readonly hasInlineSummary: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const query = useEnvironmentQuery(
    serverEnvironment.machineResources({ environmentId, input: {} }),
  );
  const state = evaluateEnvironmentLoad(query.data, {
    connected: true,
    enabled: true,
    canRead: true,
    isPending: query.isPending,
    error: query.error,
  });

  if (state.kind === "loading") {
    return <span>{gt("Reading machine resources…")}</span>;
  }
  if (state.kind === "unavailable") {
    return <span>{unavailableLoadLabel(state.reason, state.errorMessage, gt)}</span>;
  }

  const parts = query.data ? machineSummaryParts(query.data, m) : null;
  const showSummary = !hasInlineSummary && parts !== null;
  const hasAlerts = state.memoryPressureHigh || state.diskWarning !== null;

  if (!showSummary && !hasAlerts) {
    return (
      <span>
        {gt("Memory pressure: normal ({percent}% used)", {
          percent: Math.round(state.memoryUsedShare * 100),
        })}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono tabular-nums">
      {showSummary ? (
        <span>
          {parts.map((part, index) => (
            <span key={part.text}>
              {index > 0 ? " · " : null}
              <span
                className={cn(
                  part.tone === "warning" && "text-warning-foreground",
                  part.tone === "danger" && "text-destructive",
                )}
              >
                {part.text}
              </span>
            </span>
          ))}
        </span>
      ) : null}
      {state.memoryPressureHigh ? (
        <span className="font-sans font-medium text-warning-foreground">
          {gt("Memory pressure: high ({percent}% used)", {
            percent: Math.round(state.memoryUsedShare * 100),
          })}
        </span>
      ) : null}
      {state.diskWarning !== null ? (
        <span
          className={cn(
            "font-sans font-medium",
            state.diskWarning.tone === "danger" ? "text-destructive" : "text-warning-foreground",
          )}
        >
          {gt("Low disk space ({free} free)", {
            free: formatCompactLoadMemory(state.diskWarning.availableBytes),
          })}
        </span>
      ) : null}
    </span>
  );
}
