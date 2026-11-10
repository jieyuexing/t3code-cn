// Each plugin owns a Scope that holds everything it registered, in the manner of Cordis contexts:
// closing it stops the process and withdraws the views and commands, so nothing outlives a disable or reload.
import {
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
import { HostCallInput, jsonBytes, type Json, type PluginDataFile } from "./PluginIpc.ts";
import {
  loadPluginDirectory,
  resolveInsideDirectory,
  type PluginRegistration,
} from "./PluginManifestLoader.ts";
import { spawnPluginProcess, type PluginProcess } from "./PluginProcess.ts";
import { makePluginStore, type PluginStore, type RegistryRecord } from "./PluginStore.ts";

export interface PluginHostOptions {
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
}

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_VIEW_SCRIPT_BYTES = 1024 * 1024;
const MAX_VIEW_STYLE_BYTES = 256 * 1024;
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
  /** Makes concurrent first calls share one process start. */
  readonly startLock: Semaphore.Semaphore;
  settingValues: Record<string, PluginSettingValue>;
  readonly views: Array<Omit<PluginHostView, "generation">>;
  readonly commands: Array<PluginHostCommand>;
}

const decodeHostCallInput = Schema.decodeUnknownEffect(HostCallInput);

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
  overrides: Partial<PluginHostOptions> & { readonly stateDir: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const store: PluginStore = yield* makePluginStore(overrides.stateDir);
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
  });

  const entryOf = (slot: Slot): PluginHostEntry => {
    const registration = slot.registration;
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
      ...(slot.problem === undefined ? {} : { problem: slot.problem }),
      settings: registration?.manifest.settings ?? [],
      settingValues: slot.settingValues,
    };
  };

  const emit = Effect.suspend(() => {
    const active = hostEnabled ? [...slots.values()] : [];
    return SubscriptionRef.set(snapshotRef, {
      hostEnabled,
      registered: slots.size,
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

  const serveHostCall = (slot: Slot) =>
    Effect.fn("PluginHost.serveHostCall")(function* (
      method: "settings.get" | "storage.get" | "storage.set",
      input: Json,
    ) {
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
  const ensureRunning = Effect.fn("PluginHost.ensureRunning")(function* (slot: Slot) {
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

  const eligible = (slot: Slot) =>
    slot.enabled &&
    slot.consent === "granted" &&
    slot.problem === undefined &&
    slot.registration !== undefined;

  /** Offers the plugin's views and commands; the process starts on the first call. */
  const start = Effect.fn("PluginHost.start")(function* (slot: Slot) {
    const registration = slot.registration;
    if (!hostEnabled || slot.scope !== undefined || registration === undefined || !eligible(slot))
      return;
    const scope = yield* Scope.fork(hostScope, "sequential");
    slot.scope = scope;
    slot.failures = 0;
    slot.generation += 1;
    yield* offer(slot, registration, scope);
    yield* setState(slot, { _tag: "standby" });
  });

  const stop = Effect.fn("PluginHost.stop")(function* (slot: Slot) {
    const scope = slot.scope;
    slot.scope = undefined;
    slot.offer = undefined;
    if (scope !== undefined) yield* Scope.close(scope, Exit.void);
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
    if (view === undefined) return yield* fail("not-found", viewId);
    const read = (relative: string, limit: number) =>
      resolveInsideDirectory(registration.directory, relative).pipe(
        Effect.provide(platform),
        Effect.flatMap((file) => fs.readFileString(file)),
        Effect.mapError(() => fail("io-failed", `${relative} cannot be read.`)),
        Effect.filterOrFail(
          (text) => Buffer.byteLength(text) <= limit,
          () => fail("io-failed", `${relative} is too large.`),
        ),
      );
    const script = yield* read(view.script, MAX_VIEW_SCRIPT_BYTES);
    const style = view.style === undefined ? null : yield* read(view.style, MAX_VIEW_STYLE_BYTES);
    return { generation, script, style };
  });

  const invoke = Effect.fn("PluginHost.invoke")(function* (
    slot: Slot,
    handler: string,
    input: Json,
  ) {
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

  const remove = Effect.fn("PluginHost.remove")(function* (slot: Slot) {
    yield* stop(slot);
    slots.delete(slot.id);
    yield* persistRegistry.pipe(Effect.tapError(() => Effect.sync(() => slots.set(slot.id, slot))));
    const { [slot.id]: _removed, ...rest } = consent;
    consent = rest;
    yield* store.writeConsent(consent).pipe(Effect.ignore);
    yield* emit;
  });

  const enable = Effect.fn("PluginHost.enable")(function* (slot: Slot, grantConsent: boolean) {
    const registration = slot.registration;
    if (registration === undefined || slot.problem !== undefined)
      return yield* fail("invalid-plugin", slot.problem);
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
    yield* start(slot);
    yield* emit;
  });

  const disable = Effect.fn("PluginHost.disable")(function* (slot: Slot) {
    yield* stop(slot);
    slot.enabled = false;
    yield* persistRegistry;
    yield* emit;
  });

  const reload = Effect.fn("PluginHost.reload")(function* (slot: Slot) {
    yield* stop(slot);
    yield* refresh(slot);
    yield* start(slot);
    yield* emit;
  });

  const resume = Effect.fn("PluginHost.resume")(function* (slot: Slot) {
    if (!eligible(slot)) return yield* fail("not-running", slot.id);
    yield* stop(slot);
    yield* start(slot);
  });

  const activateAll = Effect.fn("PluginHost.activateAll")(function* () {
    consent = yield* store.readConsent.pipe(Effect.orElseSucceed(() => ({})));
    for (const slot of slots.values()) {
      yield* refresh(slot);
      yield* start(slot);
    }
    yield* emit;
  });

  /** Stops every plugin and forgets what was parsed, so a closed switch leaves nothing loaded. */
  const deactivateAll = Effect.fn("PluginHost.deactivateAll")(function* () {
    for (const slot of slots.values()) {
      yield* stop(slot);
      slot.registration = undefined;
      slot.problem = undefined;
      slot.consent = "required";
      slot.settingValues = {};
    }
    yield* emit;
  });

  const setHostEnabled = Effect.fn("PluginHost.setHostEnabled")(function* (enabled: boolean) {
    if (enabled === hostEnabled) return;
    hostEnabled = enabled;
    yield* persistRegistry.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          hostEnabled = !enabled;
        }),
      ),
    );
    yield* enabled ? activateAll() : deactivateAll();
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
    return yield* make({ stateDir: config.stateDir });
  }),
);
