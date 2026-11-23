import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react";
import { AlertTriangleIcon } from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  extractHostHeadroom,
  formatHostHeadroomMetrics,
  formatHostHeadroomUnavailable,
  formatHostHeadroomWarning,
  summarizeHostHeadroom,
  type HeadroomHostTarget,
  type HostHeadroomSummary,
} from "./deviceHostHeadroom.cn";

const hostMachineResourcesAtom = environmentAtomList(
  "web-device-host-machine-resources",
  (environmentId) => serverEnvironment.machineResources({ environmentId, input: {} }),
);

/**
 * Subscribes only to connected, readable hosts currently visible on the Devices settings page.
 * Unmounting the page drops all atom subscriptions so polling (`idleTtlMs: 0`) stops at once.
 */
export function useDeviceHostHeadroom(
  hosts: ReadonlyArray<HeadroomHostTarget>,
): HostHeadroomSummary {
  const m = useMessages();
  const connectedHosts = hosts.filter((host) => host.connected);
  const readableIds = useEnvironmentsWithScope(connectedHosts, AuthOrchestrationReadScope);
  const queryIds = connectedHosts
    .filter((host) => readableIds.has(host.environmentId))
    .map((host) => host.environmentId);
  const results = useAtomValue(hostMachineResourcesAtom(environmentIdsKey(queryIds)));
  const resultById = new Map<EnvironmentId, (typeof results)[number]>();
  for (let index = 0; index < queryIds.length; index += 1) {
    const result = results[index];
    if (result) resultById.set(queryIds[index]!, result);
  }

  const entries = hosts.map((host) => {
    const result = resultById.get(host.environmentId);
    const snapshot = result ? Option.getOrNull(AsyncResult.value(result)) : null;
    const error =
      result && result._tag === "Failure" ? formatEnvironmentQueryError(result.cause, m) : null;
    return extractHostHeadroom({
      environmentId: host.environmentId,
      label: host.label,
      connected: host.connected,
      canRead: readableIds.has(host.environmentId),
      isPending: result ? result.waiting : false,
      error,
      snapshot,
    });
  });

  return summarizeHostHeadroom(entries, m);
}

export function DeviceHostHeadroomWarnings({ summary }: { readonly summary: HostHeadroomSummary }) {
  const gt = useGT();
  const m = useMessages();
  if (summary.alerts.length === 0) return null;
  return (
    <>
      {summary.alerts.map((alert) => (
        <p
          key={alert.environmentId}
          role="status"
          data-slot="device-host-headroom-warning"
          className={cn(
            "mt-1 flex flex-wrap items-center gap-1.5 text-xs",
            alert.tone === "danger" ? "text-destructive" : "text-warning-foreground",
          )}
        >
          <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            {formatHostHeadroomWarning(alert, summary.multi, m)}
          </span>
          <Popover>
            <PopoverTrigger render={<InlineButton />}>
              <T>Details</T>
            </PopoverTrigger>
            <PopoverPopup side="bottom" align="start" width="sm" padding="compact">
              <p className="text-sm font-medium">{alert.label}</p>
              <p className="mt-1 font-mono text-2xs tabular-nums text-muted-foreground">
                {formatHostHeadroomMetrics(alert, m)}
              </p>
              {alert.diskAvailableBytes !== null && alert.diskTotalBytes !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {gt("T3 data volume: {free} free of {total}", {
                    free: formatBytes(alert.diskAvailableBytes),
                    total: formatBytes(alert.diskTotalBytes),
                  })}
                </p>
              ) : null}
              <div className="mt-2">
                <Button
                  size="xs"
                  variant="outline"
                  render={
                    <Link to="/settings/diagnostics" search={{ machine: alert.environmentId }} />
                  }
                >
                  <T>View diagnostics</T>
                </Button>
              </div>
            </PopoverPopup>
          </Popover>
        </p>
      ))}
    </>
  );
}

export function DeviceHostHeadroomPill({ summary }: { readonly summary: HostHeadroomSummary }) {
  const gt = useGT();
  const m = useMessages();
  const { pill } = summary;
  if (pill === null) return null;

  const isAlert = pill.tone === "warning" || pill.tone === "danger";
  const badgeClassName =
    pill.tone === "danger"
      ? "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-destructive/45 bg-destructive/10 px-2 font-mono text-2xs tabular-nums whitespace-nowrap text-destructive"
      : pill.tone === "warning"
        ? "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-warning/45 bg-warning-surface px-2 font-mono text-2xs tabular-nums whitespace-nowrap text-warning-foreground"
        : pill.tone === "ok"
          ? "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border/75 bg-muted/45 px-2 font-mono text-2xs tabular-nums whitespace-nowrap text-muted-foreground"
          : pill.interactive
            ? "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border/75 bg-muted/45 px-2 font-mono text-2xs tabular-nums whitespace-nowrap text-muted-foreground"
            : "shrink-0 text-2xs tabular-nums whitespace-nowrap text-muted-foreground";

  const content = (
    <>
      {isAlert ? <AlertTriangleIcon className="size-3 shrink-0" aria-hidden /> : null}
      <span>{pill.text}</span>
    </>
  );

  if (!pill.interactive) {
    return (
      <span data-slot="device-host-headroom" className={badgeClassName}>
        {content}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={100}
        render={
          <button
            type="button"
            data-slot="device-host-headroom"
            className={cn(
              badgeClassName,
              "cursor-pointer outline-hidden hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          />
        }
      >
        {content}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md" padding="compact">
        {!summary.multi && pill.detail ? (
          <>
            <p className="text-sm font-medium">{summary.sorted[0]?.label}</p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {pill.detail}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">
              {gt("Host headroom ({count})", { count: summary.sorted.length })}
            </p>
            <dl className="mt-2 space-y-2 text-xs">
              {summary.sorted.map((entry) => (
                <div key={entry.environmentId} className="flex items-start justify-between gap-3">
                  <dt className="min-w-0 truncate font-medium text-foreground">{entry.label}</dt>
                  <dd
                    className={cn(
                      "shrink-0 text-right font-mono text-2xs tabular-nums",
                      entry.status === "ready" && entry.tone === "danger" && "text-destructive",
                      entry.status === "ready" &&
                        entry.tone === "warning" &&
                        "text-warning-foreground",
                      entry.status !== "ready" && "text-muted-foreground",
                    )}
                  >
                    {entry.status === "ready" ? (
                      <>
                        <span className="block">{formatHostHeadroomMetrics(entry, m)}</span>
                        {entry.staleError ? (
                          <span className="block font-sans text-muted-foreground">
                            {entry.staleError}
                          </span>
                        ) : null}
                      </>
                    ) : entry.status === "loading" ? (
                      gt("Loading…")
                    ) : (
                      <>
                        <span className="block">{formatHostHeadroomUnavailable(entry, m)}</span>
                        {entry.detail ? (
                          <span className="block max-w-48 truncate font-sans">{entry.detail}</span>
                        ) : null}
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}
