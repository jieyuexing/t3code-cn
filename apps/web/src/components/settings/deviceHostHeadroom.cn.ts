import { connectionRoutes } from "@t3tools/client-runtime/connection";
import { machineVolumeTone } from "@t3tools/client-runtime/machine-resources";
import type { EnvironmentId, HostResourcesSnapshot, SshDeviceHostConfig } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";
import type { EnvironmentPresentation } from "../../state/environments";

export type HeadroomAlertTone = "ok" | "warning" | "danger";

export type HostHeadroomUnavailableReason = "offline" | "no-permission" | "error" | "not-reported";

export interface HeadroomHostTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
}

export type HostHeadroomEntry =
  | {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly status: "loading";
    }
  | {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly status: "unavailable";
      readonly reason: HostHeadroomUnavailableReason;
      readonly detail?: string | undefined;
    }
  | {
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly status: "ready";
      readonly tone: HeadroomAlertTone;
      readonly memoryAvailableBytes: number | null;
      readonly diskAvailableBytes: number | null;
      readonly diskTotalBytes: number | null;
      readonly staleError?: string | undefined;
    };

export type ReadyHostHeadroomEntry = Extract<HostHeadroomEntry, { status: "ready" }>;
export type AlertHostHeadroomEntry = ReadyHostHeadroomEntry & {
  readonly tone: "warning" | "danger";
};

export interface HostHeadroomSummary {
  readonly sorted: ReadonlyArray<HostHeadroomEntry>;
  readonly alerts: ReadonlyArray<AlertHostHeadroomEntry>;
  readonly multi: boolean;
  readonly pill: {
    readonly text: string;
    readonly tone: "ok" | "warning" | "danger" | "muted";
    readonly interactive: boolean;
    readonly detail?: string | undefined;
  } | null;
}

function entryTightnessRank(entry: HostHeadroomEntry): number {
  if (entry.status === "loading") return 0;
  if (entry.status === "unavailable") return 1;
  switch (entry.tone) {
    case "ok":
      return 2;
    case "warning":
      return 3;
    case "danger":
      return 4;
  }
}

export function extractHostHeadroom(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly canRead: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly snapshot: HostResourcesSnapshot | null;
}): HostHeadroomEntry {
  const { environmentId, label, connected, canRead, error, snapshot } = input;
  if (!connected) {
    return { environmentId, label, status: "unavailable", reason: "offline" };
  }
  if (!canRead) {
    return { environmentId, label, status: "unavailable", reason: "no-permission" };
  }
  if (snapshot === null) {
    if (error !== null) {
      return { environmentId, label, status: "unavailable", reason: "error", detail: error };
    }
    return { environmentId, label, status: "loading" };
  }

  const memoryAvailableBytes =
    snapshot.totalMemoryBytes > 0 ? Math.max(0, snapshot.availableMemoryBytes) : null;
  const t3Volume = snapshot.storage?.volumes.find((volume) => volume.roles.includes("t3Home"));
  const hasDisk = t3Volume !== undefined && t3Volume.totalBytes > 0;
  const diskAvailableBytes = hasDisk ? Math.max(0, t3Volume.availableBytes) : null;
  const diskTotalBytes = hasDisk ? t3Volume.totalBytes : null;

  if (memoryAvailableBytes === null && diskAvailableBytes === null) {
    if (error !== null) {
      return { environmentId, label, status: "unavailable", reason: "error", detail: error };
    }
    return { environmentId, label, status: "unavailable", reason: "not-reported" };
  }

  const volumeTone = hasDisk ? machineVolumeTone(t3Volume) : "default";
  const tone: HeadroomAlertTone =
    volumeTone === "danger" ? "danger" : volumeTone === "warning" ? "warning" : "ok";

  return {
    environmentId,
    label,
    status: "ready",
    tone,
    memoryAvailableBytes,
    diskAvailableBytes,
    diskTotalBytes,
    ...(error !== null ? { staleError: error } : {}),
  };
}

/** Most constrained first: alert severity descending, then free disk ascending, then RAM ascending. */
export function compareHostHeadroomTightness(
  left: HostHeadroomEntry,
  right: HostHeadroomEntry,
): number {
  const rankDiff = entryTightnessRank(right) - entryTightnessRank(left);
  if (rankDiff !== 0) return rankDiff;
  if (left.status === "ready" && right.status === "ready") {
    const leftDisk = left.diskAvailableBytes ?? Number.POSITIVE_INFINITY;
    const rightDisk = right.diskAvailableBytes ?? Number.POSITIVE_INFINITY;
    if (leftDisk !== rightDisk) return leftDisk - rightDisk;
    const leftMem = left.memoryAvailableBytes ?? Number.POSITIVE_INFINITY;
    const rightMem = right.memoryAvailableBytes ?? Number.POSITIVE_INFINITY;
    if (leftMem !== rightMem) return leftMem - rightMem;
  }
  return left.label.localeCompare(right.label);
}

export function formatHostHeadroomMetrics(
  entry: ReadyHostHeadroomEntry,
  resolve: MessageResolver,
): string {
  const parts: string[] = [];
  if (entry.memoryAvailableBytes !== null) {
    parts.push(
      resolve(msg("Free RAM {bytes}"), { bytes: formatBytes(entry.memoryAvailableBytes) }),
    );
  }
  if (entry.diskAvailableBytes !== null) {
    parts.push(resolve(msg("Free disk {bytes}"), { bytes: formatBytes(entry.diskAvailableBytes) }));
  }
  return parts.join(" · ");
}

export function formatHostHeadroomUnavailable(
  entry: Extract<HostHeadroomEntry, { status: "unavailable" }>,
  resolve: MessageResolver,
): string {
  switch (entry.reason) {
    case "offline":
      return resolve(msg("Host disconnected · Headroom unknown"));
    case "no-permission":
      return resolve(msg("No permission · Headroom unknown"));
    case "error":
      return resolve(msg("Read failed · Headroom unknown"));
    case "not-reported":
      return resolve(msg("Headroom not reported"));
  }
}

export function formatHostHeadroomWarning(
  entry: AlertHostHeadroomEntry,
  multi: boolean,
  resolve: MessageResolver,
): string {
  const memory =
    entry.memoryAvailableBytes !== null ? formatBytes(entry.memoryAvailableBytes) : null;
  const disk = entry.diskAvailableBytes !== null ? formatBytes(entry.diskAvailableBytes) : null;
  if (memory !== null && disk !== null) {
    return multi
      ? resolve(
          msg(
            "{host}: only {memory} RAM and {disk} disk free. Booting a simulator may fail with disk_space.",
          ),
          { host: entry.label, memory, disk },
        )
      : resolve(
          msg(
            "Only {memory} RAM and {disk} disk free. Booting a simulator may fail with disk_space.",
          ),
          { memory, disk },
        );
  }
  if (disk !== null) {
    return multi
      ? resolve(
          msg("{host}: only {disk} disk free. Booting a simulator may fail with disk_space."),
          { host: entry.label, disk },
        )
      : resolve(msg("Only {disk} disk free. Booting a simulator may fail with disk_space."), {
          disk,
        });
  }
  return multi
    ? resolve(msg("{host}: low headroom"), { host: entry.label })
    : resolve(msg("Low host headroom"));
}

export function summarizeHostHeadroom(
  entries: ReadonlyArray<HostHeadroomEntry>,
  resolve: MessageResolver,
): HostHeadroomSummary {
  if (entries.length === 0) {
    return { sorted: [], alerts: [], multi: false, pill: null };
  }
  const sorted = [...entries].sort(compareHostHeadroomTightness);
  const alerts = sorted.filter(
    (entry): entry is AlertHostHeadroomEntry =>
      entry.status === "ready" && (entry.tone === "warning" || entry.tone === "danger"),
  );
  const multi = entries.length > 1;
  if (!multi) {
    const only = sorted[0]!;
    switch (only.status) {
      case "ready":
        return {
          sorted,
          alerts,
          multi: false,
          pill: {
            text: formatHostHeadroomMetrics(only, resolve),
            tone: only.tone,
            interactive: Boolean(only.staleError),
            ...(only.staleError ? { detail: only.staleError } : {}),
          },
        };
      case "loading":
        return {
          sorted,
          alerts,
          multi: false,
          pill: {
            text: resolve(msg("Loading headroom…")),
            tone: "muted",
            interactive: false,
          },
        };
      case "unavailable":
        return {
          sorted,
          alerts,
          multi: false,
          pill: {
            text: formatHostHeadroomUnavailable(only, resolve),
            tone: "muted",
            interactive: Boolean(only.detail),
            ...(only.detail ? { detail: only.detail } : {}),
          },
        };
    }
  }

  if (alerts.length === 1) {
    const worst = alerts[0]!;
    return {
      sorted,
      alerts,
      multi: true,
      pill: {
        text: resolve(msg("{count} hosts · {host} low headroom"), {
          count: entries.length,
          host: worst.label,
        }),
        tone: worst.tone,
        interactive: true,
      },
    };
  }
  if (alerts.length > 1) {
    const worst = alerts[0]!;
    return {
      sorted,
      alerts,
      multi: true,
      pill: {
        text: resolve(msg("{count} hosts · {alerts} low headroom"), {
          count: entries.length,
          alerts: alerts.length,
        }),
        tone: worst.tone,
        interactive: true,
      },
    };
  }

  const tightestReady = sorted.find((entry) => entry.status === "ready");
  if (tightestReady) {
    return {
      sorted,
      alerts,
      multi: true,
      pill: {
        text: `${tightestReady.label} · ${formatHostHeadroomMetrics(tightestReady, resolve)}`,
        tone: "ok",
        interactive: true,
      },
    };
  }

  if (sorted.some((entry) => entry.status === "loading")) {
    return {
      sorted,
      alerts,
      multi: true,
      pill: {
        text: resolve(msg("Loading headroom…")),
        tone: "muted",
        interactive: true,
      },
    };
  }

  return {
    sorted,
    alerts,
    multi: true,
    pill: {
      text: resolve(msg("{count} hosts · Headroom unknown"), { count: entries.length }),
      tone: "muted",
      interactive: true,
    },
  };
}

/**
 * Connected environments that disabled device support are omitted when others in scope enabled it,
 * while disconnected environments stay visible so their offline state is surfaced instead of hidden.
 */
export function selectLocalSimulatorHeadroomEnvironments<
  T extends Pick<EnvironmentPresentation, "environmentId" | "connection" | "serverConfig">,
>(
  scopeEnvironments: ReadonlyArray<T>,
  activeEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  if (activeEnvironmentIds.size === 0) return scopeEnvironments;
  return scopeEnvironments.filter(
    (environment) =>
      activeEnvironmentIds.has(environment.environmentId) ||
      environment.connection.phase !== "connected" ||
      environment.serverConfig === null,
  );
}

function parseSshHostTarget(
  rawTarget: string,
  explicitPort: number | undefined,
): { readonly host: string; readonly port: number | null } | null {
  let host = rawTarget.trim();
  if (host.length === 0) return null;
  const atIndex = host.lastIndexOf("@");
  if (atIndex > 0) host = host.slice(atIndex + 1).trim();
  let port: number | null = explicitPort ?? null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(host);
  if (bracketed) {
    host = bracketed[1]!.trim();
    if (port === null && bracketed[2]) port = Number.parseInt(bracketed[2], 10);
  } else {
    const colonSegments = host.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      host = colonSegments[0]!.trim();
      if (port === null) port = Number.parseInt(colonSegments[1]!, 10);
    }
  }
  const normalized = host.toLowerCase();
  if (normalized.length === 0 || isLocalLoopbackHost(normalized)) return null;
  return { host: normalized, port };
}

function urlHostname(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.length === 0 || isLocalLoopbackHost(hostname) ? null : hostname;
  } catch {
    return null;
  }
}

function environmentMatchesSshTarget(
  environment: EnvironmentPresentation,
  targetHost: string,
  targetPort: number | null,
): boolean {
  const serverHostname = environment.serverConfig?.hostname?.trim().toLowerCase();
  if (serverHostname && !isLocalLoopbackHost(serverHostname) && serverHostname === targetHost) {
    return true;
  }
  if (urlHostname(environment.displayUrl) === targetHost) return true;
  for (const endpoint of environment.serverConfig?.directEndpoints ?? []) {
    if (urlHostname(endpoint.httpBaseUrl) === targetHost) return true;
  }
  for (const route of connectionRoutes(environment.entry)) {
    if (route.profile._tag === "None") continue;
    const profile = route.profile.value;
    if (profile._tag === "BearerConnectionProfile") {
      if (urlHostname(profile.httpBaseUrl) === targetHost) return true;
    } else if (profile._tag === "SshConnectionProfile") {
      if (
        targetPort !== null &&
        profile.target.port !== null &&
        targetPort !== profile.target.port
      ) {
        continue;
      }
      const sshHost = profile.target.hostname.trim().toLowerCase();
      const sshAlias = profile.target.alias.trim().toLowerCase();
      if (
        (!isLocalLoopbackHost(sshHost) && sshHost === targetHost) ||
        (!isLocalLoopbackHost(sshAlias) && sshAlias === targetHost)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function matchSshDeviceHostToEnvironment(
  sshHost: Pick<SshDeviceHostConfig, "target" | "port">,
  environments: ReadonlyArray<EnvironmentPresentation>,
): EnvironmentPresentation | null {
  const parsed = parseSshHostTarget(sshHost.target, sshHost.port);
  if (parsed === null) return null;
  const matches = environments.filter((environment) =>
    environmentMatchesSshTarget(environment, parsed.host, parsed.port),
  );
  if (matches.length === 0) return null;
  return (
    matches.find(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    ) ?? matches[0]!
  );
}
