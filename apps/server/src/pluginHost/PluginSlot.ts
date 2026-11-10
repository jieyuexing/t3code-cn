// What the host keeps for each registered plugin, and the small questions asked of it.
import {
  PLUGIN_HOST_SERVICE_NAMES,
  PluginHostError,
  type PluginHostCommand,
  type PluginHostState,
  type PluginHostView,
  type PluginId,
  type PluginSettingValue,
} from "@t3tools/contracts";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { PluginRegistration } from "./PluginManifestLoader.ts";
import type { PluginProcess } from "./PluginProcess.ts";
import type { RegistryRecord } from "./PluginStore.ts";

export interface Slot {
  readonly id: PluginId;
  path: string;
  enabled: boolean;
  registration: PluginRegistration | undefined;
  problem: string | undefined;
  consent: "granted" | "required";
  generation: number;
  state: PluginHostState;
  /** Consecutive process failures since the plugin was activated or last ran stably. */
  failures: number;
  running: PluginProcess | undefined;
  /** Open while the plugin is active; closing it stops the process and withdraws everything. */
  scope: Scope.Closeable | undefined;
  /** Holds the offered views and commands; closed while the plugin cannot serve them. */
  offer: Scope.Closeable | undefined;
  /** The delivered copy of each offered view's page, by view id. */
  readonly viewFiles: Map<string, string>;
  /** Set while a reload or resume takes the plugin and its dependents down; reconciliation then leaves it off. */
  suspended: boolean;
  /** The injected services that are not available while the plugin is `waiting`. */
  waitingFor: ReadonlyArray<string>;
  /** Why another plugin's claim on a service keeps this one from starting. */
  conflict: string | undefined;
  /** Makes concurrent first calls share one process start. */
  readonly startLock: Semaphore.Semaphore;
  settingValues: Record<string, PluginSettingValue>;
  readonly views: Array<Omit<PluginHostView, "generation">>;
  readonly commands: Array<PluginHostCommand>;
}

export const makeSlot = (record: RegistryRecord): Slot => ({
  id: record.id,
  path: record.path,
  enabled: record.enabled,
  registration: undefined,
  problem: undefined,
  consent: "required",
  generation: 0,
  state: { _tag: "idle" },
  failures: 0,
  running: undefined,
  scope: undefined,
  offer: undefined,
  viewFiles: new Map(),
  suspended: false,
  waitingFor: [],
  conflict: undefined,
  startLock: Semaphore.makeUnsafe(1),
  settingValues: {},
  views: [],
  commands: [],
});

export const fail = (reason: PluginHostError["reason"], detail?: string) =>
  new PluginHostError({
    reason,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 1000) }),
  });

const RESERVED_SERVICES = new Set<string>(PLUGIN_HOST_SERVICE_NAMES);

/** The plugin services a plugin injects, without the host's own. */
export const injectedServices = (slot: Slot) =>
  (slot.registration?.manifest.inject ?? []).filter((name) => !RESERVED_SERVICES.has(name));

export const providedServices = (slot: Slot) =>
  (slot.registration?.manifest.provides ?? []).map((service) => service.name);

export const eligible = (slot: Slot) =>
  slot.enabled &&
  slot.consent === "granted" &&
  slot.problem === undefined &&
  slot.registration !== undefined;

/** A provider's service is available while its scope is open, even if its process crashed, unless it is quarantined. */
export const serviceAvailable = (provider: Slot) =>
  provider.scope !== undefined && provider.state._tag !== "quarantined";
