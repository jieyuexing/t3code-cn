import { EnvironmentId, type HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import type { FleetEnvironmentNode } from "./environmentsMap.logic";
import {
  EnvironmentNodeDiagnosticsBar,
  EnvironmentNodeLoadRow,
  EnvironmentsMapLoadToggle,
} from "./EnvironmentsMapLoad.cn";

const GiB = 1024 ** 3;
const ENV_NORMAL = EnvironmentId.make("env-normal");
const ENV_WARN = EnvironmentId.make("env-warn");
const ENV_LOADING = EnvironmentId.make("env-loading");
const ENV_ERROR = EnvironmentId.make("env-error");
const ENV_FORBIDDEN = EnvironmentId.make("env-forbidden");
const ENV_OFFLINE = EnvironmentId.make("env-offline");

const testState = vi.hoisted(() => ({
  queries: new Map<
    string,
    {
      data: HostResourcesSnapshot | null;
      isPending: boolean;
      error: string | null;
    }
  >(),
  forbidden: new Set<string>(),
  mountedCount: new Map<string, number>(),
}));

function setup() {
  testState.queries.clear();
  testState.forbidden.clear();
  testState.mountedCount.clear();
}

vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: string) => !testState.forbidden.has(environmentId),
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    machineResources: ({ environmentId }: { environmentId: string }) => ({
      __mockEnvId: environmentId,
    }),
  },
}));

vi.mock("~/state/query", async () => {
  const React = await import("react");
  return {
    useEnvironmentQuery: (atom: { __mockEnvId?: string } | null) => {
      const envId = atom?.__mockEnvId;
      React.useEffect(() => {
        if (!envId) return;
        testState.mountedCount.set(envId, (testState.mountedCount.get(envId) ?? 0) + 1);
        return () => {
          testState.mountedCount.set(
            envId,
            Math.max(0, (testState.mountedCount.get(envId) ?? 1) - 1),
          );
        };
      }, [envId]);
      const entry = envId ? testState.queries.get(envId) : undefined;
      return {
        data: entry?.data ?? null,
        dataUpdatedAt: 0,
        error: entry?.error ?? null,
        failure: null,
        isPending: entry?.isPending ?? false,
        isSuccess: entry?.data !== null && entry?.data !== undefined,
        refresh: () => undefined,
      };
    },
  };
});

function makeNode(
  environmentId: EnvironmentId,
  phase: FleetEnvironmentNode["phase"] = "connected",
): FleetEnvironmentNode {
  return {
    id: `env:${environmentId}`,
    kind: "environment",
    environmentId,
    label: environmentId,
    machine: "server",
    phase,
    enabled: true,
    routeCount: 1,
    outgoing: "loaded",
    outgoingError: null,
    linking: "ready",
    mintable: true,
    canWriteAccess: true,
    hasLinkAddress: true,
  };
}

describe("EnvironmentsMapLoad components", () => {
  it("renders the toolbar switch off by default and toggles state", async () => {
    setup();
    const onChange = vi.fn();
    await using screen = await render(
      <EnvironmentsMapLoadToggle checked={false} onCheckedChange={onChange} />,
    );
    const sw = screen.getByRole("switch", { name: "Show load" });
    await expect.element(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders loading, normal, warning, and unavailable load rows and unmounts queries cleanly", async () => {
    setup();
    testState.forbidden.add(ENV_FORBIDDEN);
    testState.queries.set(ENV_LOADING, { data: null, isPending: true, error: null });
    testState.queries.set(ENV_ERROR, {
      data: null,
      isPending: false,
      error: "Connection timed out",
    });
    testState.queries.set(ENV_NORMAL, {
      data: {
        sampledAt: 1,
        cpuUtilization: 0.18,
        cpuCount: 8,
        availableMemoryBytes: 22.6 * GiB,
        totalMemoryBytes: 64 * GiB,
      },
      isPending: false,
      error: null,
    });
    testState.queries.set(ENV_WARN, {
      data: {
        sampledAt: 1,
        cpuUtilization: 0.84,
        cpuCount: 8,
        availableMemoryBytes: 3.2 * GiB,
        totalMemoryBytes: 64 * GiB,
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/",
              name: "Macintosh HD",
              fileSystem: "apfs",
              totalBytes: 500 * GiB,
              availableBytes: 11 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      },
      isPending: false,
      error: null,
    });

    await using screen = await render(
      <div>
        <EnvironmentNodeLoadRow node={makeNode(ENV_LOADING)} environment={undefined} />
        <EnvironmentNodeLoadRow node={makeNode(ENV_NORMAL)} environment={undefined} />
        <EnvironmentNodeLoadRow node={makeNode(ENV_WARN)} environment={undefined} />
        <EnvironmentNodeLoadRow node={makeNode(ENV_ERROR)} environment={undefined} />
        <EnvironmentNodeLoadRow node={makeNode(ENV_FORBIDDEN)} environment={undefined} />
        <EnvironmentNodeLoadRow node={makeNode(ENV_OFFLINE, "offline")} environment={undefined} />
      </div>,
    );

    await expect.element(screen.getByText("Reading load…")).toBeVisible();
    await expect.element(screen.getByText("CPU 18% · 23 GB avail")).toBeVisible();
    await expect.element(screen.getByText("CPU 84% · 3.2 GB avail")).toBeVisible();
    await expect.element(screen.getByText("Mem high")).toBeVisible();
    await expect.element(screen.getByText("Disk 11G")).toBeVisible();
    await expect.element(screen.getByText("Connection timed out")).toBeVisible();
    await expect.element(screen.getByText("No permission to read load")).toBeVisible();
    await expect.element(screen.getByText("Not connected · load unavailable")).toBeVisible();

    // Disconnected and forbidden nodes never mount machineResources queries.
    expect(testState.mountedCount.get(ENV_OFFLINE) ?? 0).toBe(0);
    expect(testState.mountedCount.get(ENV_FORBIDDEN) ?? 0).toBe(0);
    expect(testState.mountedCount.get(ENV_NORMAL)).toBe(1);

    await screen.unmount();
    expect(testState.mountedCount.get(ENV_NORMAL)).toBe(0);
  });

  it("renders machine summary and diagnostics link in FleetDetails independently of the toolbar toggle", async () => {
    setup();
    testState.queries.set(ENV_WARN, {
      data: {
        sampledAt: 1,
        cpuUtilization: 0.84,
        cpuCount: 8,
        availableMemoryBytes: 3.2 * GiB,
        totalMemoryBytes: 64 * GiB,
        storage: {
          sampledAt: 1,
          volumes: [
            {
              mountPoint: "/",
              name: "Macintosh HD",
              fileSystem: "apfs",
              totalBytes: 500 * GiB,
              availableBytes: 11 * GiB,
              roles: ["t3Home"],
            },
          ],
        },
      },
      isPending: false,
      error: null,
    });

    await using screen = await render(
      <EnvironmentNodeDiagnosticsBar environmentId={ENV_WARN} connected hasInlineSummary={false} />,
    );

    await expect.element(screen.getByText(/CPU 84%/)).toBeVisible();
    await expect.element(screen.getByText(/Memory pressure: high/)).toBeVisible();
    await expect.element(screen.getByText(/Low disk space/)).toBeVisible();
    const link = screen.getByRole("link", { name: "Open diagnostics" });
    await expect.element(link).toHaveAttribute("href", `/settings/diagnostics?machine=${ENV_WARN}`);
  });
});
