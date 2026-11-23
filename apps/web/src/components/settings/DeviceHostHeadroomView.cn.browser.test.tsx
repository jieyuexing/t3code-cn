import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type HostResourcesSnapshot, ServerConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import type { EnvironmentPresentation } from "../../state/environments";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

const state = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  readableIds: new Set<EnvironmentId>(),
  machineResultsAtom: null as Atom.Writable<
    ReadonlyMap<EnvironmentId, AsyncResult.AsyncResult<HostResourcesSnapshot, Error>>
  > | null,
  activeSubscriptions: new Set<EnvironmentId>(),
  deviceState: {
    hostStatus: "ready" as const,
    hostStatuses: {},
    hosts: [
      {
        kind: "local" as const,
        id: "local",
        label: "This machine",
        platforms: [
          { platform: "ios" as const, available: true },
          { platform: "android" as const, available: true },
        ],
        hubInstalled: true,
        agentDeviceInstalled: true,
      },
    ],
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/tmp/hub",
    revision: 1,
    supportsEasHosts: true,
    supportsSimlockHosts: true,
  },
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online" as const,
    environments: state.environments,
    presentationById: new Map(),
  }),
  usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
  usePrimaryEnvironment: () => state.environments[0] ?? null,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments) =>
    new Set(
      environments
        .map((environment) => environment.environmentId)
        .filter((id) => state.readableIds.has(id)),
    ),
}));

vi.mock(import("../../state/device"), async (original) => {
  const actual = await original();
  const deviceAtom = Atom.family(() => Atom.make(() => AsyncResult.success(state.deviceState)));
  return {
    ...actual,
    deviceEnvironment: {
      ...actual.deviceEnvironment,
      state: deviceAtom as never,
    },
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const machineResultsAtom = Atom.make<
    ReadonlyMap<EnvironmentId, AsyncResult.AsyncResult<HostResourcesSnapshot, Error>>
  >(new Map());
  state.machineResultsAtom = machineResultsAtom;
  const machineAtom = Atom.family((input: { readonly environmentId: EnvironmentId }) =>
    Atom.make((get) => {
      state.activeSubscriptions.add(input.environmentId);
      get.addFinalizer(() => {
        state.activeSubscriptions.delete(input.environmentId);
      });
      return get(machineResultsAtom).get(input.environmentId) ?? AsyncResult.initial(true);
    }),
  );
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      machineResources: machineAtom as never,
    },
  };
});

vi.mock(import("./useHostConnectionChecks"), () => ({
  useHostConnectionChecks: () => ({
    checks: {},
    testConnection: () => undefined,
  }),
}));

import { DeviceSourcesSettings } from "./DeviceSourcesSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";

const decodeServerConfig = Schema.decodeSync(ServerConfig);

function makeServerConfig(
  environmentId: EnvironmentId,
  label: string,
  options: {
    hostname?: string;
    deviceHosts?: ServerConfig["settings"]["deviceHosts"];
    easDeviceHosts?: ServerConfig["settings"]["easDeviceHosts"];
    simlockDeviceHosts?: ServerConfig["settings"]["simlockDeviceHosts"];
  } = {},
) {
  return decodeServerConfig({
    environment: {
      environmentId,
      label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      orchestrationProtocolVersion: 2,
      capabilities: {},
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
    },
    cwd: "/workspace",
    ...(options.hostname ? { hostname: options.hostname } : {}),
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      enableDeviceSupport: true,
      simlockDeviceHostsEnabled: true,
      deviceHosts: options.deviceHosts ?? [],
      easDeviceHosts: options.easDeviceHosts ?? [],
      simlockDeviceHosts: options.simlockDeviceHosts ?? [],
    },
  });
}

function makeEnv(
  id: string,
  label: string,
  options: {
    connected?: boolean;
    hostname?: string;
    httpBaseUrl?: string;
    deviceHosts?: ServerConfig["settings"]["deviceHosts"];
    easDeviceHosts?: ServerConfig["settings"]["easDeviceHosts"];
    simlockDeviceHosts?: ServerConfig["settings"]["simlockDeviceHosts"];
  } = {},
): EnvironmentPresentation {
  const environmentId = EnvironmentId.make(id);
  const connected = options.connected ?? true;
  const httpBaseUrl = options.httpBaseUrl ?? "http://127.0.0.1:3773/";
  return {
    environmentId,
    label,
    displayUrl: httpBaseUrl,
    relayManaged: false,
    entry: httpBaseUrl.includes("127.0.0.1")
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
    connection: { phase: connected ? "connected" : "offline", error: null, traceId: null },
    refusedRouteIds: [],
    serverConfig: connected ? makeServerConfig(environmentId, label, options) : null,
  };
}

function makeSnapshot(
  availableMemoryBytes: number,
  diskAvailableBytes: number,
): HostResourcesSnapshot {
  return {
    sampledAt: 1_700_000_000_000,
    cpuUtilization: 0.25,
    cpuCount: 8,
    availableMemoryBytes,
    totalMemoryBytes: 32 * GiB,
    storage: {
      sampledAt: 1_700_000_000_000,
      volumes: [
        {
          mountPoint: "/",
          name: "Macintosh HD",
          fileSystem: "apfs",
          totalBytes: 200 * GiB,
          availableBytes: diskAvailableBytes,
          roles: ["t3Home"],
        },
      ],
    },
  };
}

function setup() {
  state.environments = [];
  state.readableIds = new Set();
  state.activeSubscriptions = new Set();
}

it("renders loading, normal, warning, offline, no-permission, error, and multi-env Popover and stops polling on unmount", async () => {
  setup();
  const envA = makeEnv("env-a", "Machine A", {
    hostname: "machine-a.local",
    deviceHosts: [
      { kind: "ssh", id: "ssh-c", label: "Machine C Host", target: "dev@machine-c.tailnet" },
      { kind: "ssh", id: "ssh-plain", label: "Plain SSH Box", target: "ci@plain-ssh.lan" },
    ],
    easDeviceHosts: [
      {
        kind: "eas",
        id: "eas-1",
        label: "Expo Simulators",
        accessToken: "",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ],
    simlockDeviceHosts: [
      {
        kind: "simlock",
        id: "sim-1",
        label: "Simlock Pool",
        gatewayUrl: "https://simlock.example.ts.net:4700",
        agentToken: "",
        maxLeases: 2,
        maxLeaseMinutes: 60,
      },
    ],
  });
  const envC = makeEnv("env-c", "Machine C", {
    hostname: "machine-c.tailnet",
    httpBaseUrl: "http://machine-c.tailnet:3773/",
  });
  const envB = makeEnv("env-b", "Machine B", {
    connected: false,
    httpBaseUrl: "http://machine-b.lan:3773/",
  });
  const envNoPerm = makeEnv("env-noperm", "Machine D", {
    httpBaseUrl: "http://machine-d.lan:3773/",
  });
  const envErr = makeEnv("env-err", "Machine E", {
    httpBaseUrl: "http://machine-e.lan:3773/",
  });

  state.environments = [envA, envC, envB, envNoPerm, envErr];
  state.readableIds = new Set([envA.environmentId, envC.environmentId, envErr.environmentId]);
  // Leave envA pending initially to assert loading state.
  const resultsMap = new Map<
    EnvironmentId,
    AsyncResult.AsyncResult<HostResourcesSnapshot, Error>
  >();
  resultsMap.set(envA.environmentId, AsyncResult.initial(true));
  resultsMap.set(envC.environmentId, AsyncResult.success(makeSnapshot(3.2 * GiB, 11.2 * GiB)));
  resultsMap.set(
    envErr.environmentId,
    AsyncResult.failure(Cause.fail(new Error("Monitor unavailable"))),
  );
  appAtomRegistry.set(state.machineResultsAtom!, resultsMap);

  await using screen = await render(
    <AppAtomRegistryProvider>
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <DeviceSourcesSettings supportsEas supportsSimlock />
      </SettingsScopeProvider>
    </AppAtomRegistryProvider>,
    { router: "/settings/devices" },
  );

  // Local simulators row shows multi-host alert summary pill and expanded warning for Machine C.
  await expect.element(screen.getByText("5 hosts · Machine C low headroom")).toBeInTheDocument();
  await expect
    .element(
      screen.getByText(
        "Machine C: only 3.20 GB RAM and 11.2 GB disk free. Booting a simulator may fail with disk_space.",
      ),
    )
    .toBeInTheDocument();

  // Matched SSH row shows Machine C warning headroom; unmatched SSH, Expo, and Simlock show none.
  await expect
    .element(screen.getByText("Free RAM 3.20 GB · Free disk 11.2 GB"))
    .toBeInTheDocument();
  const headroomSlots = screen.container.querySelectorAll('[data-slot="device-host-headroom"]');
  expect(headroomSlots.length).toBe(2);

  // Open multi-host Popover to inspect all 5 host states (warning, loading, offline, no-permission, error).
  await userEvent.click(screen.getByRole("button", { name: /5 hosts · Machine C low headroom/i }));
  await expect.element(page.getByText("Host headroom (5)")).toBeInTheDocument();
  await expect.element(page.getByText("Loading…")).toBeInTheDocument();
  await expect.element(page.getByText("Host disconnected · Headroom unknown")).toBeInTheDocument();
  await expect.element(page.getByText("No permission · Headroom unknown")).toBeInTheDocument();
  await expect.element(page.getByText("Read failed · Headroom unknown")).toBeInTheDocument();

  // Resolve envA to normal and switch scope to envA single-env to verify single-host normal pill.
  const updatedMap = new Map(resultsMap);
  updatedMap.set(envA.environmentId, AsyncResult.success(makeSnapshot(22.6 * GiB, 1.92 * TiB)));
  appAtomRegistry.set(state.machineResultsAtom!, updatedMap);
  await screen.rerender(
    <AppAtomRegistryProvider>
      <SettingsScopeProvider search={{ machine: envA.environmentId }} onChange={() => {}}>
        <DeviceSourcesSettings supportsEas supportsSimlock />
      </SettingsScopeProvider>
    </AppAtomRegistryProvider>,
  );
  await expect
    .element(screen.getByText("Free RAM 22.6 GB · Free disk 1.92 TB"))
    .toBeInTheDocument();

  // Only connected + readable visible hosts subscribed (envA + envC).
  expect(state.activeSubscriptions.has(envA.environmentId)).toBe(true);
  expect(state.activeSubscriptions.has(envC.environmentId)).toBe(true);
  expect(state.activeSubscriptions.has(envB.environmentId)).toBe(false);
  expect(state.activeSubscriptions.has(envNoPerm.environmentId)).toBe(false);

  // Unmounting stops all subscriptions immediately.
  await screen.unmount();
  expect(state.activeSubscriptions.size).toBe(0);
});
