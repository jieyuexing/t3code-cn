import type { EnvironmentId, HostResourcesSnapshot, SshDeviceHostConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { m } from "../../i18n/messages";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  compareHostHeadroomTightness,
  extractHostHeadroom,
  formatHostHeadroomMetrics,
  formatHostHeadroomWarning,
  matchSshDeviceHostToEnvironment,
  selectLocalSimulatorHeadroomEnvironments,
  summarizeHostHeadroom,
  type HostHeadroomEntry,
} from "./deviceHostHeadroom.cn";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

const envId = (id: string) => id as EnvironmentId;

function makeSnapshot(
  overrides: Partial<HostResourcesSnapshot> & { readonly omitStorage?: boolean } = {},
): HostResourcesSnapshot {
  const { omitStorage, ...rest } = overrides;
  const base: HostResourcesSnapshot = {
    sampledAt: 1_700_000_000_000,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 22.6 * GiB,
    totalMemoryBytes: 32 * GiB,
    ...(omitStorage
      ? {}
      : {
          storage: {
            sampledAt: 1_700_000_000_000,
            volumes: [
              {
                mountPoint: "/Volumes/Work",
                name: "Work",
                fileSystem: "apfs",
                totalBytes: 500 * GiB,
                availableBytes: 400 * GiB,
                roles: ["worktrees"],
              },
              {
                mountPoint: "/",
                name: "Macintosh HD",
                fileSystem: "apfs",
                totalBytes: 3.63 * TiB,
                availableBytes: 1.92 * TiB,
                roles: ["t3Home"],
              },
            ],
          },
        }),
    ...rest,
  };
  return base;
}

function makeEnvironment(
  id: string,
  options: {
    label?: string;
    connected?: boolean;
    hostname?: string;
    httpBaseUrl?: string;
    sshHost?: { hostname: string; alias?: string; port?: number | null };
  } = {},
): EnvironmentPresentation {
  const environmentId = envId(id);
  const label = options.label ?? id;
  const connected = options.connected ?? true;
  const httpBaseUrl = options.httpBaseUrl ?? "http://127.0.0.1:3773/";
  return {
    environmentId,
    label,
    displayUrl: httpBaseUrl,
    relayManaged: false,
    entry: options.sshHost
      ? {
          target: new SshConnectionTarget({
            environmentId,
            label,
            connectionId: `ssh:${id}`,
          }),
          profile: Option.some(
            new SshConnectionProfile({
              connectionId: `ssh:${id}`,
              environmentId,
              label,
              target: {
                alias: options.sshHost.alias ?? options.sshHost.hostname,
                hostname: options.sshHost.hostname,
                username: "dev",
                port: options.sshHost.port ?? null,
              },
            }),
          ),
          enabled: true,
        }
      : httpBaseUrl.includes("127.0.0.1")
        ? {
            target: new PrimaryConnectionTarget({
              environmentId,
              label,
              httpBaseUrl,
              wsBaseUrl: "ws://127.0.0.1:3773/",
            }),
            profile: Option.none(),
            enabled: true,
          }
        : {
            target: new BearerConnectionTarget({
              environmentId,
              label,
              connectionId: `bearer:${id}`,
            }),
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: `bearer:${id}`,
                environmentId,
                label,
                httpBaseUrl,
                wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
              }),
            ),
            enabled: true,
          },
    connection: {
      phase: connected ? "connected" : "offline",
      error: null,
      traceId: null,
    },
    serverConfig: connected
      ? ({
          hostname: options.hostname,
          directEndpoints: options.httpBaseUrl
            ? [{ id: "ep-1", label: "Direct", httpBaseUrl, kind: "tailnet" }]
            : [],
          settings: { enableDeviceSupport: true },
        } as unknown as EnvironmentPresentation["serverConfig"])
      : null,
    refusedRouteIds: [],
  };
}

describe("extractHostHeadroom", () => {
  it("reports offline, no-permission, error, loading, and not-reported without zero values", () => {
    expect(
      extractHostHeadroom({
        environmentId: envId("a"),
        label: "A",
        connected: false,
        canRead: true,
        isPending: false,
        error: null,
        snapshot: makeSnapshot(),
      }),
    ).toEqual({
      environmentId: envId("a"),
      label: "A",
      status: "unavailable",
      reason: "offline",
    });

    expect(
      extractHostHeadroom({
        environmentId: envId("a"),
        label: "A",
        connected: true,
        canRead: false,
        isPending: false,
        error: null,
        snapshot: null,
      }),
    ).toEqual({
      environmentId: envId("a"),
      label: "A",
      status: "unavailable",
      reason: "no-permission",
    });

    expect(
      extractHostHeadroom({
        environmentId: envId("a"),
        label: "A",
        connected: true,
        canRead: true,
        isPending: false,
        error: "Timed out",
        snapshot: null,
      }),
    ).toEqual({
      environmentId: envId("a"),
      label: "A",
      status: "unavailable",
      reason: "error",
      detail: "Timed out",
    });

    expect(
      extractHostHeadroom({
        environmentId: envId("a"),
        label: "A",
        connected: true,
        canRead: true,
        isPending: true,
        error: null,
        snapshot: null,
      }),
    ).toEqual({
      environmentId: envId("a"),
      label: "A",
      status: "loading",
    });

    expect(
      extractHostHeadroom({
        environmentId: envId("a"),
        label: "A",
        connected: true,
        canRead: true,
        isPending: false,
        error: null,
        snapshot: makeSnapshot({
          availableMemoryBytes: 0,
          totalMemoryBytes: 0,
          omitStorage: true,
        }),
      }),
    ).toEqual({
      environmentId: envId("a"),
      label: "A",
      status: "unavailable",
      reason: "not-reported",
    });
  });

  it("extracts RAM and T3 data volume free space and maps diskSpaceLevel to alert tones", () => {
    const okEntry = extractHostHeadroom({
      environmentId: envId("a"),
      label: "Machine A",
      connected: true,
      canRead: true,
      isPending: false,
      error: null,
      snapshot: makeSnapshot(),
    });
    expect(okEntry).toMatchObject({
      status: "ready",
      tone: "ok",
      memoryAvailableBytes: 22.6 * GiB,
      diskAvailableBytes: 1.92 * TiB,
    });
    if (okEntry.status === "ready") {
      expect(formatHostHeadroomMetrics(okEntry, m)).toBe("Free RAM 22.6 GB · Free disk 1.92 TB");
    }

    const lowEntry = extractHostHeadroom({
      environmentId: envId("c"),
      label: "Machine C",
      connected: true,
      canRead: true,
      isPending: false,
      error: null,
      snapshot: makeSnapshot({
        availableMemoryBytes: 3.2 * GiB,
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/",
              name: "Disk",
              fileSystem: "apfs",
              totalBytes: 200 * GiB,
              availableBytes: 11.2 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      }),
    });
    expect(lowEntry).toMatchObject({ status: "ready", tone: "warning" });

    const criticalEntry = extractHostHeadroom({
      environmentId: envId("d"),
      label: "Machine D",
      connected: true,
      canRead: true,
      isPending: false,
      error: null,
      snapshot: makeSnapshot({
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/",
              name: "Disk",
              fileSystem: "apfs",
              totalBytes: 200 * GiB,
              availableBytes: 3 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      }),
    });
    expect(criticalEntry).toMatchObject({ status: "ready", tone: "danger" });
  });
});

describe("compareHostHeadroomTightness & summarizeHostHeadroom", () => {
  it("sorts by alert tone descending, then free disk ascending, then available RAM ascending", () => {
    const entries: HostHeadroomEntry[] = [
      {
        environmentId: envId("ok-more-ram"),
        label: "OK More RAM",
        status: "ready",
        tone: "ok",
        memoryAvailableBytes: 16 * GiB,
        diskAvailableBytes: 50 * GiB,
        diskTotalBytes: 200 * GiB,
      },
      {
        environmentId: envId("ok-less-ram"),
        label: "OK Less RAM",
        status: "ready",
        tone: "ok",
        memoryAvailableBytes: 4 * GiB,
        diskAvailableBytes: 50 * GiB,
        diskTotalBytes: 200 * GiB,
      },
      {
        environmentId: envId("ok-less-disk"),
        label: "OK Less Disk",
        status: "ready",
        tone: "ok",
        memoryAvailableBytes: 32 * GiB,
        diskAvailableBytes: 30 * GiB,
        diskTotalBytes: 200 * GiB,
      },
      {
        environmentId: envId("warning"),
        label: "Warning",
        status: "ready",
        tone: "warning",
        memoryAvailableBytes: 32 * GiB,
        diskAvailableBytes: 12 * GiB,
        diskTotalBytes: 200 * GiB,
      },
      {
        environmentId: envId("danger"),
        label: "Danger",
        status: "ready",
        tone: "danger",
        memoryAvailableBytes: 64 * GiB,
        diskAvailableBytes: 4 * GiB,
        diskTotalBytes: 200 * GiB,
      },
      {
        environmentId: envId("offline"),
        label: "Offline",
        status: "unavailable",
        reason: "offline",
      },
      {
        environmentId: envId("loading"),
        label: "Loading",
        status: "loading",
      },
    ];

    const sorted = [...entries].sort(compareHostHeadroomTightness);
    expect(sorted.map((entry) => entry.environmentId)).toEqual([
      "danger",
      "warning",
      "ok-less-disk",
      "ok-less-ram",
      "ok-more-ram",
      "offline",
      "loading",
    ]);
  });

  it("summarizes single and multi-environment host states cleanly", () => {
    const okA: HostHeadroomEntry = {
      environmentId: envId("a"),
      label: "Machine A",
      status: "ready",
      tone: "ok",
      memoryAvailableBytes: 22.6 * GiB,
      diskAvailableBytes: 1.92 * TiB,
      diskTotalBytes: 3.63 * TiB,
    };
    const warnC: HostHeadroomEntry = {
      environmentId: envId("c"),
      label: "Machine C",
      status: "ready",
      tone: "warning",
      memoryAvailableBytes: 3.2 * GiB,
      diskAvailableBytes: 11.2 * GiB,
      diskTotalBytes: 200 * GiB,
    };
    const dangerD: HostHeadroomEntry = {
      environmentId: envId("d"),
      label: "Machine D",
      status: "ready",
      tone: "danger",
      memoryAvailableBytes: 2 * GiB,
      diskAvailableBytes: 3 * GiB,
      diskTotalBytes: 200 * GiB,
    };

    const singleOk = summarizeHostHeadroom([okA], m);
    expect(singleOk.multi).toBe(false);
    expect(singleOk.pill).toEqual({
      text: "Free RAM 22.6 GB · Free disk 1.92 TB",
      tone: "ok",
      interactive: false,
    });

    const multiWarn = summarizeHostHeadroom([okA, warnC], m);
    expect(multiWarn.multi).toBe(true);
    expect(multiWarn.alerts).toHaveLength(1);
    expect(multiWarn.pill).toEqual({
      text: "2 hosts · Machine C low headroom",
      tone: "warning",
      interactive: true,
    });

    const multiAlertTwo = summarizeHostHeadroom([okA, warnC, dangerD], m);
    expect(multiAlertTwo.alerts).toHaveLength(2);
    expect(multiAlertTwo.pill).toEqual({
      text: "3 hosts · 2 low headroom",
      tone: "danger",
      interactive: true,
    });

    const okB: HostHeadroomEntry = {
      environmentId: envId("b"),
      label: "Machine B",
      status: "ready",
      tone: "ok",
      memoryAvailableBytes: 8 * GiB,
      diskAvailableBytes: 80 * GiB,
      diskTotalBytes: 200 * GiB,
    };
    const multiOk = summarizeHostHeadroom([okA, okB], m);
    expect(multiOk.pill).toEqual({
      text: "Machine B · Free RAM 8.00 GB · Free disk 80.0 GB",
      tone: "ok",
      interactive: true,
    });

    expect(
      formatHostHeadroomWarning(
        warnC as Extract<HostHeadroomEntry, { status: "ready" }> & { tone: "warning" },
        true,
        m,
      ),
    ).toContain("Machine C");
  });
});

describe("selectLocalSimulatorHeadroomEnvironments & matchSshDeviceHostToEnvironment", () => {
  it("keeps active and offline environments when some are active, or falls back to scope environments", () => {
    const activeA = makeEnvironment("a", { connected: true });
    const disabledB = makeEnvironment("b", { connected: true });
    const offlineC = makeEnvironment("c", { connected: false });

    expect(
      selectLocalSimulatorHeadroomEnvironments(
        [activeA, disabledB, offlineC],
        new Set([envId("a")]),
      ).map((e) => e.environmentId),
    ).toEqual(["a", "c"]);

    expect(
      selectLocalSimulatorHeadroomEnvironments([disabledB, offlineC], new Set()).map(
        (e) => e.environmentId,
      ),
    ).toEqual(["b", "c"]);
  });

  it("matches SSH device hosts to known T3 environments and ignores loopback or unrelated hosts", () => {
    const localEnv = makeEnvironment("local", {
      hostname: "my-macbook.local",
      httpBaseUrl: "http://127.0.0.1:3773/",
    });
    const machineC = makeEnvironment("c", {
      label: "Machine C",
      hostname: "machine-c",
      httpBaseUrl: "http://machine-c.tailnet:3773/",
    });
    const sshEnv = makeEnvironment("s", {
      label: "Build Box",
      connected: false,
      sshHost: { hostname: "build.lan", alias: "buildbox", port: 2222 },
    });

    const envs = [localEnv, machineC, sshEnv];
    const ssh = (target: string, port?: number): Pick<SshDeviceHostConfig, "target" | "port"> =>
      port === undefined ? { target } : { target, port };

    expect(
      matchSshDeviceHostToEnvironment(ssh("dev@machine-c.tailnet", 22), envs)?.environmentId,
    ).toBe("c");
    expect(matchSshDeviceHostToEnvironment(ssh("buildbox", 2222), envs)?.environmentId).toBe("s");
    expect(matchSshDeviceHostToEnvironment(ssh("buildbox", 22), envs)).toBeNull();
    expect(matchSshDeviceHostToEnvironment(ssh("dev@localhost"), envs)).toBeNull();
    expect(matchSshDeviceHostToEnvironment(ssh("ci@unknown.lan"), envs)).toBeNull();
  });
});
