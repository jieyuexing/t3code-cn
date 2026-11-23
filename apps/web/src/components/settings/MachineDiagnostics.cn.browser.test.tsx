import { getEnvironmentMachineHistory } from "@t3tools/client-runtime/machine-resources-history-cn";
import { EnvironmentId, type HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { MachineResourcesSection, MachineResourcesView } from "./MachineResourcesSection";

const GiB = 1024 ** 3;
const ENV_A = EnvironmentId.make("env-diag-a");

const testState = vi.hoisted(() => ({
  snapshot: null as HostResourcesSnapshot | null,
  error: null as string | null,
  isPending: false,
  listeners: new Set<() => void>(),
}));

function setLiveSnapshot(next: HostResourcesSnapshot | null) {
  testState.snapshot = next;
  for (const listener of testState.listeners) {
    listener();
  }
}

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));

vi.mock("~/state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      machineResources: ({ environmentId }: { environmentId: string }) =>
        ({
          __mockEnvId: environmentId,
        }) as never,
    },
  };
});

vi.mock("~/lib/resourceTelemetryState", () => ({
  useResourceTelemetry: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => undefined,
    retry: () => Promise.resolve(),
  }),
  useResourceTelemetryHistory: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));

vi.mock("~/state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/query")>();
  const React = await import("react");
  return {
    ...actual,
    useEnvironmentQuery: () => {
      const [, forceRender] = React.useReducer((count: number) => count + 1, 0);
      React.useEffect(() => {
        testState.listeners.add(forceRender);
        return () => {
          testState.listeners.delete(forceRender);
        };
      }, []);
      return {
        data: testState.snapshot,
        dataUpdatedAt: testState.snapshot?.sampledAt ?? 0,
        error: testState.error,
        failure: null,
        isPending: testState.isPending,
        isSuccess: testState.snapshot !== null,
        refresh: () => undefined,
      };
    },
  };
});

describe("MachineResourcesSection C2 diagnostics", () => {
  it("switches subtabs, inspects per-core user/system shares, freezes on pause while buffering, and clears history on unmount", async () => {
    setLiveSnapshot({
      sampledAt: 1_700_000_000_000,
      cpuUtilization: 0.24,
      cpuCount: 2,
      cpuModel: "Apple M4 Max",
      loadAverage: { one: 2.14, five: 1.85, fifteen: 1.62 },
      availableMemoryBytes: 24 * GiB,
      totalMemoryBytes: 64 * GiB,
      swap: { usedBytes: 0, totalBytes: 0 },
      cpuCores: [
        { utilization: 0.384, user: 0.292, system: 0.092 },
        { utilization: 0.12, user: 0.08, system: 0.04 },
      ],
      memoryBreakdown: {
        kind: "darwin",
        appBytes: 30 * GiB,
        wiredBytes: 6 * GiB,
        compressedBytes: 4 * GiB,
        availableBytes: 24 * GiB,
      },
      memoryPressure: { level: "normal" },
      storage: {
        sampledAt: 1_700_000_000_000,
        volumes: [
          {
            mountPoint: "/",
            name: "Macintosh HD",
            fileSystem: "apfs",
            totalBytes: 500 * GiB,
            availableBytes: 250 * GiB,
            roles: ["t3Home"],
          },
        ],
      },
      network: {
        sampledAt: 1_700_000_000_000,
        warmingUp: true,
      },
    });

    const screen = await render(<MachineResourcesSection environmentId={ENV_A} />);
    await expect.element(screen.getByText("24.0%")).toBeInTheDocument();
    await expect.element(screen.getByText("Measuring…")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "CPU & memory" }));
    await expect.element(screen.getByText("Core 01")).toBeInTheDocument();
    await expect.element(screen.getByText("29.2%")).toBeInTheDocument();

    const coreButtons = screen.getByTestId("machine-core-cell").elements();
    expect(coreButtons).toHaveLength(2);
    await userEvent.click(coreButtons[1]!);
    await expect.element(screen.getByText("Core 02")).toBeInTheDocument();
    await expect.element(screen.getByText("Idle 88.0%")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await userEvent.click(screen.getByTestId("machine-pause-toggle"));
    await expect.element(screen.getByTestId("machine-status-badge")).toHaveTextContent("Paused");

    setLiveSnapshot({
      ...testState.snapshot!,
      sampledAt: 1_700_000_005_000,
      cpuUtilization: 0.77,
      network: {
        sampledAt: 1_700_000_005_000,
        downloadBytesPerSecond: 4 * 1024 * 1024,
        uploadBytesPerSecond: 512 * 1024,
      },
    });

    await expect.poll(() => getEnvironmentMachineHistory(ENV_A).length).toBe(2);
    await expect.element(screen.getByText("24.0%")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("machine-pause-toggle"));
    await expect.element(screen.getByTestId("machine-status-badge")).toHaveTextContent("Live");
    await expect.element(screen.getByText("77.0%")).toBeInTheDocument();

    await screen[Symbol.asyncDispose]();
    expect(getEnvironmentMachineHistory(ENV_A)).toEqual([]);
  });

  it("renders unavailable reasons instead of zeros and keeps legacy MachineResourcesView working", async () => {
    setLiveSnapshot({
      sampledAt: 1_700_000_010_000,
      cpuUtilization: null,
      cpuCount: 4,
      availableMemoryBytes: 8 * GiB,
      totalMemoryBytes: 16 * GiB,
      memoryBreakdown: {
        kind: "unavailable",
        unavailableReason: "vm_stat exited with code 1",
      },
      memoryPressure: {
        unavailableReason: "PSI /proc/pressure/memory not mounted",
      },
      network: {
        sampledAt: 1_700_000_010_000,
        unavailableReason: "Native monitor is disabled in this container",
      },
    });

    await using screen = await render(
      <div>
        <MachineResourcesSection environmentId={ENV_A} />
        <MachineResourcesView snapshot={null} error={null} dataUpdatedAt={0} />
      </div>,
    );

    await userEvent.click(screen.getByRole("tab", { name: "CPU & memory" }));
    await expect.element(screen.getByText("vm_stat exited with code 1")).toBeInTheDocument();
    await expect
      .element(screen.getByText("PSI /proc/pressure/memory not mounted"))
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Network" }));
    await expect
      .element(screen.getByText("Native monitor is disabled in this container"))
      .toBeInTheDocument();
  });
});
