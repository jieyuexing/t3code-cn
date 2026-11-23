import {
  EnvironmentId,
  type HostResourcesSnapshot,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetGraph,
  fleetEnvironmentNodeId,
  fleetShapeKey,
  fleetStacks,
  layoutFleetGraph,
  type FleetEnvironmentInput,
} from "./environmentsMap.logic";
import {
  CARD_LOAD_HEIGHT,
  evaluateEnvironmentLoad,
  formatCompactDiskBadgeValue,
  formatCompactLoadMemory,
} from "./environmentsMapLoad.logic.cn";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const TiB = 1024 ** 4;
const now = DateTime.makeUnsafe("2026-11-23T12:00:00.000Z");

const makeSnapshot = (overrides: Partial<HostResourcesSnapshot> = {}): HostResourcesSnapshot => ({
  sampledAt: 1_700_000_000_000,
  cpuUtilization: 0.18,
  cpuCount: 8,
  availableMemoryBytes: 22.6 * GiB,
  totalMemoryBytes: 64 * GiB,
  ...overrides,
});

const makeEnvironment = (
  name: string,
  links: ReadonlyArray<PeerLinkSummary> = [],
  overrides: Partial<FleetEnvironmentInput> = {},
): FleetEnvironmentInput => ({
  environmentId: EnvironmentId.make(name),
  label: name,
  machine: "server",
  phase: "connected",
  enabled: true,
  routes: [{ id: "tailnet", kind: "tailnet" }],
  activeRouteId: "tailnet",
  refusedRouteIds: [],
  offersLinks: true,
  canWriteAccess: true,
  hasLinkAddress: true,
  outgoing: { state: "loaded", links },
  ...overrides,
});

const makeLink = (
  target: string,
  access: PeerLinkSummary["access"] = "full-access",
): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(target),
  label: target,
  urls: [`https://${target}.example.ts.net`],
  access,
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

describe("evaluateEnvironmentLoad", () => {
  it("reports unavailable reasons without falling back to zero", () => {
    expect(
      evaluateEnvironmentLoad(null, {
        connected: false,
        enabled: false,
        canRead: true,
        isPending: false,
        error: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "off" });

    expect(
      evaluateEnvironmentLoad(null, {
        connected: false,
        enabled: true,
        connecting: true,
        canRead: true,
        isPending: false,
        error: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "connecting" });

    expect(
      evaluateEnvironmentLoad(null, {
        connected: false,
        enabled: true,
        canRead: true,
        isPending: false,
        error: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "disconnected" });

    expect(
      evaluateEnvironmentLoad(null, {
        connected: true,
        enabled: true,
        canRead: false,
        isPending: false,
        error: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "forbidden" });

    expect(
      evaluateEnvironmentLoad(null, {
        connected: true,
        enabled: true,
        canRead: true,
        isPending: false,
        error: "Request timed out",
      }),
    ).toEqual({ kind: "unavailable", reason: "error", errorMessage: "Request timed out" });

    expect(
      evaluateEnvironmentLoad(
        makeSnapshot({ cpuUtilization: null, availableMemoryBytes: 0, totalMemoryBytes: 0 }),
        {
          connected: true,
          enabled: true,
          canRead: true,
          isPending: false,
          error: null,
        },
      ),
    ).toEqual({ kind: "unavailable", reason: "unsupported" });
  });

  it("returns loading when connected and waiting for the first snapshot", () => {
    expect(
      evaluateEnvironmentLoad(null, {
        connected: true,
        enabled: true,
        canRead: true,
        isPending: true,
        error: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("evaluates normal load without warning badges", () => {
    const state = evaluateEnvironmentLoad(makeSnapshot(), {
      connected: true,
      enabled: true,
      canRead: true,
      isPending: false,
      error: null,
    });
    expect(state).toMatchObject({
      kind: "ready",
      tone: "default",
      cpuPercent: 18,
      memoryPressureHigh: false,
      diskWarning: null,
    });
  });

  it("flags high memory pressure and low/critical disk using machineResources rules", () => {
    const highMem = evaluateEnvironmentLoad(
      makeSnapshot({
        cpuUtilization: 0.84,
        availableMemoryBytes: 3.2 * GiB,
        totalMemoryBytes: 64 * GiB,
      }),
      {
        connected: true,
        enabled: true,
        canRead: true,
        isPending: false,
        error: null,
      },
    );
    expect(highMem).toMatchObject({
      kind: "ready",
      tone: "warning",
      cpuPercent: 84,
      memoryPressureHigh: true,
      diskWarning: null,
    });

    const lowAndCriticalDisk = evaluateEnvironmentLoad(
      makeSnapshot({
        cpuUtilization: 0.84,
        availableMemoryBytes: 3.2 * GiB,
        totalMemoryBytes: 64 * GiB,
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/worktrees",
              name: "Worktrees",
              fileSystem: "apfs",
              totalBytes: 500 * GiB,
              availableBytes: 12 * GiB,
              roles: ["worktrees"],
            },
            {
              mountPoint: "/",
              name: "Macintosh HD",
              fileSystem: "apfs",
              totalBytes: 500 * GiB,
              availableBytes: 4 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      }),
      {
        connected: true,
        enabled: true,
        canRead: true,
        isPending: false,
        error: null,
      },
    );
    expect(lowAndCriticalDisk).toMatchObject({
      kind: "ready",
      tone: "danger",
      memoryPressureHigh: true,
      diskWarning: {
        tone: "danger",
        mountPoint: "/",
      },
    });
  });
});

describe("compact load formatters", () => {
  it("formats memory and compact disk badge values", () => {
    expect(formatCompactLoadMemory(512 * MiB)).toBe("512 MB");
    expect(formatCompactLoadMemory(3.2 * GiB)).toBe("3.2 GB");
    expect(formatCompactLoadMemory(22.6 * GiB)).toBe("23 GB");
    expect(formatCompactLoadMemory(1.5 * TiB)).toBe("1.5 TB");

    expect(formatCompactDiskBadgeValue(512 * MiB)).toBe("512M");
    expect(formatCompactDiskBadgeValue(3.2 * GiB)).toBe("3.2G");
    expect(formatCompactDiskBadgeValue(11 * GiB)).toBe("11G");
  });
});

describe("fleet map layout with showLoad", () => {
  it("adds CARD_LOAD_HEIGHT to environment cards only, updates shapeKey, and keeps layout overlap-free", () => {
    const targetLinks = Array.from({ length: 6 }, (_, index) => makeLink(`vm-${index + 1}`));
    const graph = buildFleetGraph({
      clientLabel: "This browser",
      environments: [
        makeEnvironment("machine-a", [
          makeLink("machine-c"),
          ...targetLinks,
          makeLink("solo", "read-only"),
        ]),
        makeEnvironment("machine-b", [], { phase: "offline" }),
        makeEnvironment("machine-c", [makeLink("machine-a")]),
      ],
      now,
    });
    const stacks = fleetStacks(graph, new Set());
    const offKey = fleetShapeKey(graph, stacks, false);
    const onKey = fleetShapeKey(graph, stacks, true);
    expect(onKey).not.toBe(offKey);

    const offLayout = layoutFleetGraph(graph, stacks, 960, { showLoad: false });
    const onLayout = layoutFleetGraph(graph, stacks, 960, { showLoad: true });

    const idA = fleetEnvironmentNodeId(EnvironmentId.make("machine-a"));
    const idSolo = fleetEnvironmentNodeId(EnvironmentId.make("solo"));
    expect(onLayout.nodes.get(idA)!.height).toBe(
      offLayout.nodes.get(idA)!.height + CARD_LOAD_HEIGHT,
    );
    // Target nodes and folded stacks keep their exact height.
    expect(onLayout.nodes.get(idSolo)!.height).toBe(offLayout.nodes.get(idSolo)!.height);
    expect(onLayout.stacks.get(stacks[0]!.id)!.face.height).toBe(
      offLayout.stacks.get(stacks[0]!.id)!.face.height,
    );

    const rects = [...onLayout.nodes.values(), ...[...onLayout.stacks.values()].map((s) => s.rect)];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });
});
