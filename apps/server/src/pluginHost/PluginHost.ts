// Each plugin owns a Scope that holds everything it registered, in the manner of Cordis contexts:
// closing it stops the process and withdraws the views and commands, so nothing outlives a disable or reload.
import {
  PLUGIN_HOST_SERVICE_NAMES,
  PluginHostError,
  type PluginHostCallInput,
  type PluginHostCallResult,
  type PluginHostCommand,
  type PluginHostEntry,
  type PluginHostSnapshot,
  type PluginHostState,
  type PluginHostView,
  type PluginId,
  type PluginSettingField,
  type PluginSettingValue,
} from "@t3tools/contracts";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../config.ts";
import {
  HostCallInput,
  jsonBytes,
  ServiceCallInput,
  serviceHandler,
  type Json,
  type PluginDataFile,
} from "./PluginIpc.ts";
import { loadPluginDirectory, type PluginRegistration } from "./PluginManifestLoader.ts";
import { spawnPluginProcess, type PluginProcess } from "./PluginProcess.ts";
import { makePluginStore, type PluginStore, type RegistryRecord } from "./PluginStore.ts";
import {
  issueViewUrl,
  makePluginViewDelivery,
  type PluginViewDeliveryOptions,
} from "./PluginViewDelivery.ts";

export interface PluginHostOptions extends PluginViewDeliveryOptions {
  readonly stateDir: string;
  /** What starts a plugin process; the default is this executable's hidden `__plugin-host` command. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Consecutive failures that quarantine a plugin. */
  readonly maxFailures: number;
  readonly restartBackoff: Duration.Input;
  readonly maxRestartBackoff: Duration.Input;
  /** A process that ran this long before failing starts a fresh failure count. */
  readonly stableUptime: Duration.Input;
  readonly activationTimeout: Duration.Input;
  readonly callTimeout: Duration.Input;
  readonly stopGrace: Duration.Input;
  readonly spawnProcess: typeof spawnPluginProcess;
  /** Called when a plugin is activated or stopped, in the order reconciliation does it. */
  readonly onTransition?: (pluginId: PluginId, action: "start" | "stop") => void;
}

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STORAGE_VALUE_BYTES = 256 * 1024;

export class PluginHost extends Context.Service<
  PluginHost,
  {
    /** The current snapshot first, then each change. */
    readonly subscribe: Stream.Stream<PluginHostSnapshot>;
    readonly call: (
      input: PluginHostCallInput,
    ) => Effect.Effect<PluginHostCallResult, PluginHostError>;
  }
>()("t3/pluginHost/PluginHost") {}

interface Slot {
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

const decodeHostCallInput = Schema.decodeUnknownEffect(HostCallInput);
const decodeServiceCall = Schema.decodeUnknownEffect(ServiceCallInput);
const RESERVED_SERVICES = new Set<string>(PLUGIN_HOST_SERVICE_NAMES);

const LOG_LEVELS = { debug: "Debug", info: "Info", warn: "Warn", error: "Error" } as const;

const fail = (reason: PluginHostError["reason"], detail?: string) =>
  new PluginHostError({
    reason,
    ...(detail === undefined ? {} : { detail: detail.slice(0, 1000) }),
  });

const SETTING_VALUE_TYPES = { text: "string", boolean: "boolean", number: "number" } as const;

const settingProblem = (field: PluginSettingField, value: PluginSettingValue) =>
  typeof value === SETTING_VALUE_TYPES[field.type]
    ? undefined
    : `${field.key} must be a ${field.type}.`;

const resolveSettings = (
  fields: ReadonlyArray<PluginSettingField>,
  saved: Readonly<Record<string, PluginSettingValue>>,
) => {
  const values: Record<string, PluginSettingValue> = {};
  for (const field of fields) {
    const candidate = saved[field.key];
    const value =
      candidate !== undefined && settingProblem(field, candidate) === undefined
        ? candidate
        : field.default;
    if (value !== undefined) values[field.key] = value;
  }
  return values;
};

export const make = Effect.fn("PluginHost.make")(function* (
  overrides: Partial<PluginHostOptions> & PluginViewDeliveryOptions & { readonly stateDir: string },
) {
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const store: PluginStore = yield* makePluginStore(overrides.stateDir);
  const delivery = yield* makePluginViewDelivery(overrides);
  const load = (directory: string) => loadPluginDirectory(directory).pipe(Effect.provide(platform));
  const self = yield* resolveSelfInvocation();
  const options: PluginHostOptions = {
    command: self.command,
    args: selfInvocationArgs(self, ["__plugin-host"]),
    maxFailures: 3,
    restartBackoff: Duration.seconds(1),
    maxRestartBackoff: Duration.seconds(30),
    stableUptime: Duration.minutes(1),
    activationTimeout: Duration.seconds(10),
    callTimeout: Duration.seconds(30),
    stopGrace: Duration.seconds(2),
    spawnProcess: spawnPluginProcess,
    ...overrides,
  };
  const restartBackoffMs = Duration.toMillis(Duration.fromInputUnsafe(options.restartBackoff));
  const maxRestartBackoffMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.maxRestartBackoff),
  );
  const stableUptimeMs = Duration.toMillis(Duration.fromInputUnsafe(options.stableUptime));

  const hostScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const dataLock = yield* Semaphore.make(1);
  const slots = new Map<PluginId, Slot>();
  let registryProblem: string | undefined;
  let hostEnabled = false;
  let consent: Record<string, string> = {};
  const snapshotRef = yield* SubscriptionRef.make<PluginHostSnapshot>({
    hostEnabled: false,
    registered: 0,
    plugins: [],
    views: [],
    commands: [],
    services: [],
  });

  const entryOf = (slot: Slot): PluginHostEntry => {
    const registration = slot.registration;
    const problem = slot.problem ?? slot.conflict;
    return {
      id: slot.id,
      name: registration?.manifest.name ?? slot.id,
      version: registration?.manifest.version ?? "",
      directory: registration?.directory ?? slot.path,
      enabled: slot.enabled,
      consent: slot.consent,
      digest: registration?.digest ?? "",
      capabilities: registration?.manifest.capabilities ?? [],
      generation: slot.generation,
      state: slot.state,
      ...(slot.running?.pid === undefined ? {} : { pid: slot.running.pid }),
      ...(problem === undefined ? {} : { problem }),
      ignoredFields: registration?.ignored ?? [],
      rejectedViews: registration?.rejectedViews ?? [],
      settings: registration?.manifest.settings ?? [],
      settingValues: slot.settingValues,
      provides: (registration?.manifest.provides ?? []).map((service) => ({
        name: service.name,
        methods: service.methods.map(({ name, title, description, readOnly }) => ({
          name,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(readOnly === undefined ? {} : { readOnly }),
        })),
      })),
      waitingFor: slot.waitingFor,
    };
  };

  const injectedServices = (slot: Slot) =>
    (slot.registration?.manifest.inject ?? []).filter((name) => !RESERVED_SERVICES.has(name));
  const providedServices = (slot: Slot) =>
    (slot.registration?.manifest.provides ?? []).map((service) => service.name);

  const eligible = (slot: Slot) =>
    slot.enabled &&
    slot.consent === "granted" &&
    slot.problem === undefined &&
    slot.registration !== undefined;

  /** Plugins that want to run: eligible and not held down by a reload. */
  const claims = (slot: Slot) => hostEnabled && !slot.suspended && eligible(slot);

  /** The first plugin of `include` to declare each service name; a service has one provider. */
  const serviceOwners = (include: (slot: Slot) => boolean) => {
    const owners = new Map<string, Slot>();
    for (const slot of slots.values())
      if (include(slot))
        for (const name of providedServices(slot)) if (!owners.has(name)) owners.set(name, slot);
    return owners;
  };

  /** A provider's service is available while its scope is open, even if its process crashed, unless it is quarantined. */
  const serviceAvailable = (provider: Slot) =>
    provider.scope !== undefined && provider.state._tag !== "quarantined";

  const emit = Effect.suspend(() => {
    const active = hostEnabled ? [...slots.values()] : [];
    return SubscriptionRef.set(snapshotRef, {
      hostEnabled,
      registered: slots.size,
      services: hostEnabled
        ? [...serviceOwners(claims)].map(([name, provider]) => ({
            name,
            provider: provider.id,
            available: serviceAvailable(provider),
          }))
        : [],
      plugins: active.map(entryOf),
      views: active.flatMap((slot) =>
        slot.views.map((view) => ({ ...view, generation: slot.generation })),
      ),
      commands: active.flatMap((slot) => slot.commands),
    });
  });

  const setState = (slot: Slot, state: PluginHostState) =>
    Effect.suspend(() => {
      slot.state = state;
      return emit;
    });

  /** Records a contribution in the current scope, so closing the scope withdraws it. */
  const contribute = <A>(list: Array<A>, item: A) =>
    Effect.suspend(() => {
      list.push(item);
      return Effect.addFinalizer(() =>
        Effect.suspend(() => {
          list.splice(list.indexOf(item), 1);
          return emit;
        }),
      );
    });

  const readData = (slot: Slot) =>
    store
      .readData(slot.id)
      .pipe(Effect.orElseSucceed((): PluginDataFile => ({ settings: {}, storage: {} })));

  /** Forwards a call from `caller` to a service method, after checking everything the host can check. */
  const callService = Effect.fn("PluginHost.callService")(function* (caller: Slot, input: Json) {
    const request = yield* decodeServiceCall(input).pipe(
      Effect.mapError(() => "The request needs a service, a method and an input."),
    );
    const { service, method } = request;
    if (!injectedServices(caller).includes(service))
      return yield* Effect.fail(`Plugin ${caller.id} does not declare a dependency on ${service}.`);
    const provider = serviceOwners(claims).get(service);
    if (provider === undefined || !serviceAvailable(provider))
      return yield* Effect.fail(`The service ${service} is not available.`);
    const declared = provider.registration?.manifest.provides
      .find((candidate) => candidate.name === service)
      ?.methods.some((candidate) => candidate.name === method);
    if (declared !== true)
      return yield* Effect.fail(`The service ${service} has no method ${method}.`);
    const { process } = yield* ensureRunning(provider).pipe(
      Effect.mapError((error) => `${service} (${provider.id}): ${error.message}`),
    );
    return yield* process
      .invoke(serviceHandler(service, method), { input: request.input, caller: caller.id })
      .pipe(Effect.mapError((error) => `${service}.${method}: ${error.message}`));
  });

  const serveHostCall = (slot: Slot) =>
    Effect.fn("PluginHost.serveHostCall")(function* (
      method: "settings.get" | "storage.get" | "storage.set" | "service.call",
      input: Json,
    ) {
      if (method === "service.call") return yield* callService(slot, input);
      const request = yield* decodeHostCallInput(input).pipe(
        Effect.mapError(() => "The request needs a key."),
      );
      const key = request.key.slice(0, 128);
      if (method === "settings.get") {
        const declared = slot.registration?.manifest.settings.some((field) => field.key === key);
        return declared
          ? (slot.settingValues[key] ?? null)
          : yield* Effect.fail(`Unknown setting ${key}.`);
      }
      if (method === "storage.get") {
        const data = yield* readData(slot);
        return data.storage[key] ?? null;
      }
      const value = request.value ?? null;
      if (jsonBytes(value) > MAX_STORAGE_VALUE_BYTES)
        return yield* Effect.fail("The value is too large to store.");
      yield* dataLock
        .withPermits(1)(
          Effect.gen(function* () {
            const data = yield* readData(slot);
            yield* store.writeData(slot.id, {
              ...data,
              storage: { ...data.storage, [key]: value },
            });
          }),
        )
        .pipe(Effect.mapError(() => "The value could not be stored."));
      return null;
    });

  const runProcess = (
    slot: Slot,
    registration: PluginRegistration,
    ready: Deferred.Deferred<void, PluginHostError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* options.spawnProcess({
          registration,
          command: options.command,
          args: options.args,
          activationTimeout: options.activationTimeout,
          callTimeout: options.callTimeout,
          stopGrace: options.stopGrace,
          maxPayloadBytes: MAX_PAYLOAD_BYTES,
          injectedServices: injectedServices(slot),
          serveHostCall: serveHostCall(slot),
          onLog: (level, message) =>
            Effect.logWithLevel(LOG_LEVELS[level])(message).pipe(
              Effect.annotateLogs({ pluginId: slot.id }),
            ),
        });
        slot.running = process;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            slot.running = undefined;
          }),
        );
        yield* setState(slot, { _tag: "running" });
        yield* Deferred.succeed(ready, undefined);
        return yield* Deferred.await(process.exited);
      }),
    ).pipe(Effect.catchTags({ PluginProcessError: (error) => Effect.succeed(error.reason) }));

  /** Offers the manifest's views and commands until `slot.offer` closes. */
  const offer = Effect.fn("PluginHost.offer")(function* (
    slot: Slot,
    registration: PluginRegistration,
    parent: Scope.Scope,
  ) {
    const scope = yield* Scope.fork(parent, "sequential");
    slot.offer = scope;
    const { manifest } = registration;
    yield* Effect.gen(function* () {
      for (const view of manifest.views)
        yield* contribute(slot.views, {
          pluginId: slot.id,
          pluginName: manifest.name,
          viewId: view.id,
          title: view.title,
          placement: view.placement,
        });
      for (const command of manifest.commands)
        yield* contribute(slot.commands, {
          pluginId: slot.id,
          pluginName: manifest.name,
          commandId: command.id,
          title: command.title,
          ...(command.description === undefined ? {} : { description: command.description }),
        });
    }).pipe(Effect.provideService(Scope.Scope, scope));
  });

  const withdraw = Effect.fn("PluginHost.withdraw")(function* (slot: Slot) {
    const scope = slot.offer;
    slot.offer = undefined;
    if (scope !== undefined) yield* Scope.close(scope, Exit.void);
  });

  /** Services that depended on a quarantined provider stop, from outside the provider's own scope. */
  const requestReconcile = Effect.suspend(() =>
    mutate(reconcile()).pipe(Effect.forkIn(hostScope), Effect.asVoid),
  );

  /** Runs one process to its end, then settles into backoff, back to standby, or quarantine. */
  const cycle = Effect.fn("PluginHost.cycle")(function* (
    slot: Slot,
    registration: PluginRegistration,
    scope: Scope.Scope,
    ready: Deferred.Deferred<void, PluginHostError>,
  ) {
    yield* setState(slot, { _tag: "starting" });
    const startedAt = yield* Clock.currentTimeMillis;
    const reason = yield* runProcess(slot, registration, ready);
    yield* Deferred.fail(ready, fail("call-failed", `The plugin did not start: ${reason}`));
    const now = yield* Clock.currentTimeMillis;
    slot.failures = now - startedAt >= stableUptimeMs ? 1 : slot.failures + 1;
    yield* withdraw(slot);
    if (slot.failures >= options.maxFailures) {
      yield* setState(slot, { _tag: "quarantined", failures: slot.failures, reason });
      yield* requestReconcile;
      return;
    }
    const delay = Math.min(restartBackoffMs * 2 ** (slot.failures - 1), maxRestartBackoffMs);
    yield* setState(slot, {
      _tag: "backoff",
      failures: slot.failures,
      reason,
      retryAt: DateTime.formatIso(DateTime.makeUnsafe(now + delay)),
    });
    yield* Effect.sleep(Duration.millis(delay));
    yield* offer(slot, registration, scope);
    yield* setState(slot, { _tag: "standby" });
  });

  /** Starts the process on the first call; concurrent first calls wait for the same start. */
  const ensureRunning = Effect.fn("PluginHost.ensureRunning")(function* (
    slot: Slot,
  ): Effect.fn.Return<
    { readonly process: PluginProcess; readonly registration: PluginRegistration },
    PluginHostError
  > {
    return yield* slot.startLock.withPermits(1)(
      Effect.gen(function* () {
        const { scope, registration } = slot;
        if (scope === undefined || registration === undefined)
          return yield* fail("not-running", `${slot.id} is not enabled.`);
        const state = slot.state;
        if (state._tag === "backoff")
          return yield* fail("not-running", `Backing off until ${state.retryAt}: ${state.reason}`);
        if (state._tag === "quarantined")
          return yield* fail("not-running", `Quarantined: ${state.reason}`);
        if (slot.running === undefined) {
          const ready = yield* Deferred.make<void, PluginHostError>();
          yield* cycle(slot, registration, scope, ready).pipe(
            Effect.onExit(() =>
              Deferred.fail(ready, fail("not-running", "The plugin was stopped.")),
            ),
            Effect.forkIn(scope),
          );
          yield* Deferred.await(ready);
        }
        return slot.running === undefined
          ? yield* fail("not-running", slot.id)
          : { process: slot.running, registration };
      }),
    );
  });

  /** Offers the plugin's views and commands; the process starts on the first call. */
  const start = Effect.fn("PluginHost.start")(function* (slot: Slot) {
    const registration = slot.registration;
    if (!hostEnabled || slot.scope !== undefined || registration === undefined || !eligible(slot))
      return;
    const scope = yield* Scope.fork(hostScope, "sequential");
    slot.scope = scope;
    slot.failures = 0;
    slot.waitingFor = [];
    slot.generation += 1;
    options.onTransition?.(slot.id, "start");
    yield* offer(slot, registration, scope);
    yield* setState(slot, { _tag: "standby" });
  });

  const stop = Effect.fn("PluginHost.stop")(function* (slot: Slot) {
    const scope = slot.scope;
    slot.scope = undefined;
    slot.offer = undefined;
    if (scope !== undefined) {
      options.onTransition?.(slot.id, "stop");
      yield* Scope.close(scope, Exit.void);
    }
    yield* delivery.discard(slot.viewFiles.values());
    slot.viewFiles.clear();
    yield* setState(slot, { _tag: "idle" });
  });

  /** Rereads the manifest, consent and settings from disk. */
  const refresh = Effect.fn("PluginHost.refresh")(function* (slot: Slot) {
    const loaded = yield* load(slot.path).pipe(Effect.exit);
    if (Exit.isFailure(loaded)) {
      const error = Exit.findErrorOption(loaded);
      slot.registration = undefined;
      slot.problem = error._tag === "Some" ? error.value.reason : "The plugin could not be loaded.";
      slot.consent = "required";
      slot.settingValues = {};
      return;
    }
    const registration = loaded.value;
    slot.registration = registration;
    yield* Effect.forEach(registration.ignored, (note) =>
      Effect.logWarning(`Plugin ${slot.id}: ignored ${note}.`),
    );
    slot.problem =
      registration.manifest.id === slot.id
        ? undefined
        : `the manifest declares the id ${registration.manifest.id}, not ${slot.id}.`;
    slot.consent = consent[slot.id] === registration.digest ? "granted" : "required";
    slot.settingValues = resolveSettings(
      registration.manifest.settings,
      (yield* readData(slot)).settings,
    );
  });

  const makeSlot = (record: RegistryRecord): Slot => ({
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

  const persistRegistry = Effect.suspend(() =>
    registryProblem === undefined
      ? store
          .writeRegistry({
            enabled: hostEnabled,
            plugins: [...slots.values()].map(({ id, path: slotPath, enabled }) => ({
              id,
              path: slotPath,
              enabled,
            })),
          })
          .pipe(Effect.mapError((error) => fail("io-failed", error.message)))
      : Effect.fail(fail("io-failed", registryProblem)),
  );

  const slotOf = (pluginId: PluginId): Effect.Effect<Slot, PluginHostError> => {
    const slot = slots.get(pluginId);
    return slot === undefined ? Effect.fail(fail("not-found", pluginId)) : Effect.succeed(slot);
  };

  /** Delivers a view's page as a signed URL; the page never travels over the socket. */
  const readViewBundle = Effect.fn("PluginHost.readView")(function* (
    slot: Slot,
    viewId: string,
    generation: number,
  ) {
    const registration = slot.registration;
    if (registration === undefined || slot.offer === undefined)
      return yield* fail("not-running", `${slot.id} does not offer views right now.`);
    if (generation !== slot.generation) return yield* fail("stale-generation");
    const view = registration.manifest.views.find((candidate) => candidate.id === viewId);
    if (view === undefined) {
      const rejected = registration.rejectedViews.find((candidate) => candidate.viewId === viewId);
      return yield* rejected === undefined
        ? fail("not-found", viewId)
        : fail("view-rejected", rejected.reason);
    }
    const delivered = yield* delivery.deliver({
      pluginId: slot.id,
      viewId,
      directory: registration.directory,
      html: view.html,
    });
    const previous = slot.viewFiles.get(viewId);
    if (previous !== undefined && previous !== delivered.file) yield* delivery.discard([previous]);
    slot.viewFiles.set(viewId, delivered.file);
    return { generation, url: delivered.url, expiresAt: delivered.expiresAt };
  });

  const invoke = Effect.fn("PluginHost.invoke")(function* (
    slot: Slot,
    handler: string,
    input: Json,
  ) {
    // Service methods are reached through `context.services`, which checks the caller's dependencies.
    if (handler.startsWith("service:")) return yield* fail("not-found", handler);
    const { process } = yield* ensureRunning(slot);
    if (!process.handlers.includes(handler)) return yield* fail("not-found", handler);
    return yield* process
      .invoke(handler, input)
      .pipe(
        Effect.mapError((error) =>
          fail(
            "call-failed",
            error.detail === undefined ? error.reason : `${error.reason}: ${error.detail}`,
          ),
        ),
      );
  });

  const setSetting = Effect.fn("PluginHost.setSetting")(function* (
    slot: Slot,
    key: string,
    value: PluginSettingValue,
  ) {
    const field = slot.registration?.manifest.settings.find((candidate) => candidate.key === key);
    if (field === undefined) return yield* fail("not-found", key);
    const problem = settingProblem(field, value);
    if (problem !== undefined) return yield* fail("invalid-input", problem);
    yield* dataLock
      .withPermits(1)(
        Effect.gen(function* () {
          const data = yield* store.readData(slot.id);
          yield* store.writeData(slot.id, {
            ...data,
            settings: { ...data.settings, [key]: value },
          });
        }),
      )
      .pipe(Effect.mapError((error) => fail("io-failed", error.message)));
    slot.settingValues = { ...slot.settingValues, [key]: value };
    yield* emit;
  });

  const mutate = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect);

  const add = Effect.fn("PluginHost.add")(function* (directory: string) {
    const registration = yield* load(directory).pipe(
      Effect.mapError((error) => fail("invalid-plugin", error.reason)),
    );
    const id = registration.manifest.id;
    if (slots.has(id)) return yield* fail("already-registered", id);
    const slot = makeSlot({ id, path: registration.directory, enabled: false });
    slots.set(id, slot);
    yield* persistRegistry.pipe(Effect.tapError(() => Effect.sync(() => slots.delete(id))));
    yield* refresh(slot);
    yield* emit;
  });

  /**
   * The one place plugins start and stop. It settles which plugins should be active: those that
   * want to run and whose injected services are all provided by plugins that should be active
   * and are not quarantined. It then stops the others, dependents before their providers, and
   * starts the rest, providers before their dependents. Callers hold the management lock.
   */
  const reconcile = Effect.fn("PluginHost.reconcile")(function* () {
    if (!hostEnabled) return;
    const all = [...slots.values()];
    const owners = serviceOwners(claims);
    for (const slot of all) {
      const taken = providedServices(slot)
        .map((name) => ({ name, owner: owners.get(name) }))
        .find((candidate) => candidate.owner !== undefined && candidate.owner !== slot);
      slot.conflict =
        claims(slot) && taken?.owner !== undefined
          ? `the service ${taken.name} is already provided by ${taken.owner.id}.`
          : undefined;
    }
    const candidates = all.filter((slot) => claims(slot) && slot.conflict === undefined);
    const active = new Set<Slot>();
    const provides = (name: string, dependent: Slot) => {
      const provider = owners.get(name);
      return (
        provider !== undefined &&
        provider !== dependent &&
        active.has(provider) &&
        provider.state._tag !== "quarantined"
      );
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const slot of candidates)
        if (!active.has(slot) && injectedServices(slot).every((name) => provides(name, slot))) {
          active.add(slot);
          changed = true;
        }
    }

    const ranks = dependencyRanks(all);
    const byRank = (direction: 1 | -1) => (left: Slot, right: Slot) =>
      direction * ((ranks.get(left) ?? 0) - (ranks.get(right) ?? 0));
    for (const slot of all
      .filter((candidate) => candidate.scope !== undefined && !active.has(candidate))
      .toSorted(byRank(-1)))
      yield* stop(slot);
    for (const slot of [...active]
      .filter((candidate) => candidate.scope === undefined)
      .toSorted(byRank(1)))
      yield* start(slot);

    const cycleFrom = (start: Slot) => {
      const walk = (slot: Slot, path: ReadonlyArray<Slot>): ReadonlyArray<Slot> | undefined => {
        for (const name of injectedServices(slot)) {
          const next = owners.get(name);
          if (next === undefined || active.has(next) || !candidates.includes(next)) continue;
          if (next === start) return [...path, slot];
          if (path.includes(next) || next === slot) continue;
          const found = walk(next, [...path, slot]);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      return walk(start, []);
    };
    for (const slot of all.filter((candidate) => !active.has(candidate))) {
      if (candidates.includes(slot)) {
        slot.waitingFor = injectedServices(slot).filter((name) => !provides(name, slot));
        const cycle = cycleFrom(slot);
        yield* setState(slot, {
          _tag: "waiting",
          reason:
            cycle === undefined
              ? `waiting for ${slot.waitingFor.join(", ")}`
              : `dependency cycle: ${[...cycle, slot].map((member) => member.id).join(" → ")}`,
        });
      } else {
        slot.waitingFor = [];
        if (slot.state._tag !== "idle") yield* setState(slot, { _tag: "idle" });
      }
    }
    yield* emit;
  });

  /** How deep each plugin sits in the dependency graph: 0 without plugin dependencies, else one more than its deepest provider. */
  const dependencyRanks = (all: ReadonlyArray<Slot>) => {
    const owners = serviceOwners(
      (slot) => slot.registration !== undefined && (claims(slot) || slot.scope !== undefined),
    );
    const ranks = new Map<Slot, number>();
    const rank = (slot: Slot, visiting: ReadonlySet<Slot>): number => {
      const known = ranks.get(slot);
      if (known !== undefined) return known;
      const depth = Math.max(
        -1,
        ...injectedServices(slot).flatMap((name) => {
          const provider = owners.get(name);
          return provider === undefined || provider === slot || visiting.has(provider)
            ? []
            : [rank(provider, new Set([...visiting, slot]))];
        }),
      );
      ranks.set(slot, depth + 1);
      return depth + 1;
    };
    for (const slot of all) rank(slot, new Set());
    return ranks;
  };

  /** Takes a plugin and everything that depends on it down, runs `change`, and lets reconciliation bring them back. */
  const restarting = <A, E>(slot: Slot, change: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      slot.suspended = true;
      yield* reconcile();
      return yield* change;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          slot.suspended = false;
          return reconcile();
        }),
      ),
    );

  const remove = Effect.fn("PluginHost.remove")(function* (slot: Slot) {
    slot.suspended = true;
    yield* reconcile();
    slots.delete(slot.id);
    yield* persistRegistry.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          slot.suspended = false;
          slots.set(slot.id, slot);
        }),
      ),
    );
    const { [slot.id]: _removed, ...rest } = consent;
    consent = rest;
    yield* store.writeConsent(consent).pipe(Effect.ignore);
    yield* reconcile();
    yield* emit;
  });

  const enable = Effect.fn("PluginHost.enable")(function* (slot: Slot, grantConsent: boolean) {
    const registration = slot.registration;
    if (registration === undefined || slot.problem !== undefined)
      return yield* fail("invalid-plugin", slot.problem);
    const owners = serviceOwners((other) => other !== slot && claims(other));
    for (const name of providedServices(slot)) {
      const owner = owners.get(name);
      if (owner !== undefined)
        return yield* fail(
          "service-conflict",
          `the service ${name} is already provided by ${owner.id}.`,
        );
    }
    if (slot.consent !== "granted") {
      if (!grantConsent) return yield* fail("consent-required", slot.id);
      const next = { ...consent, [slot.id]: registration.digest };
      yield* store
        .writeConsent(next)
        .pipe(Effect.mapError((error) => fail("io-failed", error.message)));
      consent = next;
      slot.consent = "granted";
    }
    slot.enabled = true;
    yield* persistRegistry.pipe(Effect.tapError(() => Effect.sync(() => (slot.enabled = false))));
    yield* reconcile();
  });

  const disable = Effect.fn("PluginHost.disable")(function* (slot: Slot) {
    slot.enabled = false;
    yield* persistRegistry.pipe(Effect.tapError(() => Effect.sync(() => (slot.enabled = true))));
    yield* reconcile();
  });

  const reload = Effect.fn("PluginHost.reload")(function* (slot: Slot) {
    yield* restarting(slot, refresh(slot));
  });

  const resume = Effect.fn("PluginHost.resume")(function* (slot: Slot) {
    if (!eligible(slot)) return yield* fail("not-running", slot.id);
    yield* restarting(slot, Effect.void);
  });

  const activateAll = Effect.fn("PluginHost.activateAll")(function* () {
    consent = yield* store.readConsent.pipe(Effect.orElseSucceed(() => ({})));
    yield* delivery.sweep;
    for (const slot of slots.values()) yield* refresh(slot);
    yield* reconcile();
  });

  /** Stops every plugin, dependents first, and forgets what was parsed, so a closed switch leaves nothing loaded. */
  const deactivateAll = Effect.fn("PluginHost.deactivateAll")(function* (
    ranks: ReadonlyMap<Slot, number>,
  ) {
    const all = [...slots.values()];
    for (const slot of all.toSorted(
      (left, right) => (ranks.get(right) ?? 0) - (ranks.get(left) ?? 0),
    )) {
      yield* stop(slot);
      slot.registration = undefined;
      slot.problem = undefined;
      slot.conflict = undefined;
      slot.waitingFor = [];
      slot.consent = "required";
      slot.settingValues = {};
    }
    yield* emit;
  });

  const setHostEnabled = Effect.fn("PluginHost.setHostEnabled")(function* (enabled: boolean) {
    if (enabled === hostEnabled) return;
    // The dependency order comes from the manifests, which are forgotten once the switch is off.
    const ranks = dependencyRanks([...slots.values()]);
    hostEnabled = enabled;
    yield* persistRegistry.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          hostEnabled = !enabled;
        }),
      ),
    );
    yield* enabled ? activateAll() : deactivateAll(ranks);
  });

  const none = Effect.succeed({ value: null } satisfies PluginHostCallResult);

  const call = Effect.fn("PluginHost.call")(function* (input: PluginHostCallInput) {
    if (!hostEnabled && input._tag !== "setHostEnabled") return yield* fail("host-disabled");
    switch (input._tag) {
      case "setHostEnabled":
        return yield* mutate(setHostEnabled(input.enabled)).pipe(Effect.andThen(none));
      case "invoke":
        return { value: yield* invoke(yield* slotOf(input.pluginId), input.handler, input.input) };
      case "readView":
        return {
          value: yield* readViewBundle(
            yield* slotOf(input.pluginId),
            input.viewId,
            input.generation,
          ),
        };
      case "setSetting":
        return yield* mutate(
          slotOf(input.pluginId).pipe(
            Effect.flatMap((slot) => setSetting(slot, input.key, input.value)),
          ),
        ).pipe(Effect.andThen(none));
      case "add":
        return yield* mutate(add(input.path)).pipe(Effect.andThen(none));
      case "remove":
        return yield* mutate(slotOf(input.pluginId).pipe(Effect.flatMap(remove))).pipe(
          Effect.andThen(none),
        );
      case "enable":
        return yield* mutate(
          slotOf(input.pluginId).pipe(
            Effect.flatMap((slot) => enable(slot, input.grantConsent === true)),
          ),
        ).pipe(Effect.andThen(none));
      case "disable":
        return yield* mutate(slotOf(input.pluginId).pipe(Effect.flatMap(disable))).pipe(
          Effect.andThen(none),
        );
      case "reload":
        return yield* mutate(slotOf(input.pluginId).pipe(Effect.flatMap(reload))).pipe(
          Effect.andThen(none),
        );
      case "resume":
        return yield* mutate(slotOf(input.pluginId).pipe(Effect.flatMap(resume))).pipe(
          Effect.andThen(none),
        );
    }
  });

  // A broken registry or plugin shows up in the snapshot or the log and never stops the server.
  const registry = yield* store.readRegistry.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        registryProblem = error.message;
      }),
    ),
    Effect.tapError((error) => Effect.logWarning(error.message)),
    Effect.orElseSucceed(() => ({ enabled: false, plugins: [] as ReadonlyArray<RegistryRecord> })),
  );
  for (const record of registry.plugins) {
    if (!slots.has(record.id)) slots.set(record.id, makeSlot(record));
  }
  hostEnabled = registry.enabled;
  if (hostEnabled) yield* activateAll();
  else if (slots.size > 0) yield* emit;

  return PluginHost.of({
    subscribe: SubscriptionRef.changes(snapshotRef),
    call,
  });
});

export const layer = Layer.effect(
  PluginHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* make({
      stateDir: config.stateDir,
      attachmentsDir: config.attachmentsDir,
      issueUrl: issueViewUrl,
    });
  }),
);
