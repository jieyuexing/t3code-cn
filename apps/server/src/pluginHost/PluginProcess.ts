// @effect-diagnostics nodeBuiltinImport:off -- The plugin child needs Node's IPC channel, which the process spawner does not offer.
// Plugins are trusted OS-user code; the child protects the server's availability, not its data.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  decodePluginChildMessage,
  jsonBytes,
  type Json,
  type PluginChildMessage,
  type PluginHostMessage,
  type PluginLogLevel,
} from "./PluginIpc.ts";
import type { PluginRegistration } from "./PluginManifestLoader.ts";

export class PluginProcessError extends Schema.TaggedError<PluginProcessError>()(
  "PluginProcessError",
  { pluginId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} stopped: ${this.reason}`;
  }
}

export class PluginCallError extends Schema.TaggedError<PluginCallError>()("PluginCallError", {
  pluginId: Schema.String,
  handler: Schema.String,
  reason: Schema.Literals(["stopped", "timeout", "too-large", "failed"]),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return `Plugin ${this.pluginId} ${this.reason} "${this.handler}"${this.detail === undefined ? "" : `: ${this.detail}`}`;
  }
}

type ReadyMessage = Extract<PluginChildMessage, { _tag: "Ready" }>;

export interface PluginProcessOptions {
  readonly registration: PluginRegistration;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly activationTimeout: Duration.Input;
  readonly callTimeout: Duration.Input;
  readonly stopGrace: Duration.Input;
  readonly maxPayloadBytes: number;
  /** The plugin services this plugin injects. */
  readonly injectedServices: ReadonlyArray<string>;
  /** Serves `settings.get` and `storage.*`; a failure message reaches the plugin. */
  readonly serveHostCall: (
    method: Extract<PluginChildMessage, { _tag: "HostCall" }>["method"],
    input: Json,
  ) => Effect.Effect<Json, string>;
  readonly onLog: (level: PluginLogLevel, message: string) => Effect.Effect<void>;
}

export interface PluginProcess {
  readonly pid: number | undefined;
  /** Handler names the plugin registered while activating. */
  readonly handlers: ReadonlyArray<string>;
  readonly invoke: (handler: string, input: Json) => Effect.Effect<Json, PluginCallError>;
  /** Completes with a short reason once the process has exited, for any cause. */
  readonly exited: Deferred.Deferred<string>;
}

// Enough for a plugin to find its tools and temp space without inheriting the server's credentials.
const CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "LANG",
  "LC_ALL",
];
const STDERR_TAIL_BYTES = 2048;

interface CallFailure {
  readonly reason: PluginCallError["reason"];
  readonly detail?: string;
}

/** Starts the child, waits until the plugin has activated, and stops it when the scope closes. */
export const spawnPluginProcess = Effect.fn("PluginProcess.spawn")(function* (
  options: PluginProcessOptions,
) {
  const { registration } = options;
  const pluginId = registration.manifest.id;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const activationTimeout = Duration.fromInputUnsafe(options.activationTimeout);
  const callTimeout = Duration.fromInputUnsafe(options.callTimeout);
  const stopGrace = Duration.fromInputUnsafe(options.stopGrace);

  const exited = Deferred.makeUnsafe<string>();
  const ready = Deferred.makeUnsafe<ReadyMessage, PluginProcessError>();
  const pending = new Map<number, Deferred.Deferred<Json, CallFailure>>();
  let nextRequestId = 1;
  let stderrTail = "";

  const hostEnvironment = yield* HostProcess.Environment;
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of CHILD_ENV_KEYS) {
    const value = hostEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }

  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        NodeChildProcess.spawn(options.command, [...options.args], {
          cwd: registration.directory,
          env: environment,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        }),
      catch: (cause) =>
        new PluginProcessError({ pluginId, reason: `cannot start (${String(cause)})` }),
    }),
    (spawned) =>
      Effect.gen(function* () {
        if (spawned.exitCode === null && spawned.signalCode === null) {
          if (spawned.connected)
            spawned.send({ _tag: "Deactivate" } satisfies PluginHostMessage, () => undefined);
          const stopped = yield* Deferred.await(exited).pipe(Effect.timeoutOption(stopGrace));
          if (stopped._tag === "None") {
            spawned.kill("SIGKILL");
            yield* Deferred.await(exited);
          }
        }
      }),
  );

  const send = (message: PluginHostMessage) => {
    if (child.connected) child.send(message, () => undefined);
  };

  const failPending = (failure: CallFailure) => {
    for (const [requestId, deferred] of pending) {
      pending.delete(requestId);
      Deferred.doneUnsafe(deferred, Effect.fail(failure));
    }
  };

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });

  const handleMessage = (message: PluginChildMessage) => {
    switch (message._tag) {
      case "Ready":
        Deferred.doneUnsafe(ready, Effect.succeed(message));
        break;
      case "ActivationFailed":
        Deferred.doneUnsafe(
          ready,
          Effect.fail(
            new PluginProcessError({ pluginId, reason: `activation failed: ${message.message}` }),
          ),
        );
        break;
      case "Succeeded":
      case "Failed": {
        const deferred = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (deferred === undefined) break;
        if (message._tag === "Failed")
          Deferred.doneUnsafe(deferred, Effect.fail({ reason: "failed", detail: message.message }));
        else if (jsonBytes(message.value) > options.maxPayloadBytes)
          Deferred.doneUnsafe(deferred, Effect.fail({ reason: "too-large" }));
        else Deferred.doneUnsafe(deferred, Effect.succeed(message.value));
        break;
      }
      case "Log":
        runFork(options.onLog(message.level, message.message));
        break;
      case "HostCall":
        runFork(
          options.serveHostCall(message.method, message.input).pipe(
            Effect.match({
              onSuccess: (value): PluginHostMessage => ({
                _tag: "HostCallSucceeded",
                requestId: message.requestId,
                value,
              }),
              onFailure: (failure): PluginHostMessage => ({
                _tag: "HostCallFailed",
                requestId: message.requestId,
                message: failure.slice(0, 2000),
              }),
            }),
            Effect.map(send),
          ),
        );
        break;
      case "Deactivated":
        break;
    }
  };

  child.on("message", (raw) => {
    const decoded = decodePluginChildMessage(raw);
    if (Exit.isSuccess(decoded)) handleMessage(decoded.value);
  });
  const finish = (reason: string) => {
    const detail = stderrTail.trim().split("\n").at(-1)?.slice(0, 300);
    const text = detail ? `${reason}: ${detail}` : reason;
    Deferred.doneUnsafe(exited, Effect.succeed(text));
    Deferred.doneUnsafe(ready, Effect.fail(new PluginProcessError({ pluginId, reason: text })));
    failPending({ reason: "stopped" });
  };
  child.on("exit", (code, signal) =>
    finish(signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`),
  );
  child.on("error", (cause) => finish(`process error (${cause.message})`));

  send({
    _tag: "Activate",
    pluginId,
    version: registration.manifest.version,
    entryPath: registration.entryPath,
    capabilities: registration.manifest.capabilities,
    services: options.injectedServices,
    provides: registration.manifest.provides.map((service) => ({
      name: service.name,
      methods: service.methods.map((method) => method.name),
    })),
  });
  const readyMessage = yield* Deferred.await(ready).pipe(
    Effect.timeoutOption(activationTimeout),
    Effect.flatMap((result) =>
      result._tag === "Some"
        ? Effect.succeed(result.value)
        : Effect.fail(new PluginProcessError({ pluginId, reason: "did not activate in time" })),
    ),
  );

  // The manifest is what dependents were checked against, so the plugin must register exactly that.
  const registered = new Map(
    readyMessage.provided.map((service) => [service.name, service.methods]),
  );
  for (const declared of registration.manifest.provides) {
    const methods = registered.get(declared.name);
    if (methods === undefined)
      return yield* new PluginProcessError({
        pluginId,
        reason: `it declares the service ${declared.name} but did not register it with context.provide.`,
      });
    const expected = declared.methods.map((method) => method.name).toSorted();
    const actual = methods.toSorted();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      return yield* new PluginProcessError({
        pluginId,
        reason: `the service ${declared.name} registered methods [${actual.join(", ")}], not the declared [${expected.join(", ")}].`,
      });
  }
  const undeclared = [...registered.keys()].find(
    (name) => !registration.manifest.provides.some((declared) => declared.name === name),
  );
  if (undeclared !== undefined)
    return yield* new PluginProcessError({
      pluginId,
      reason: `it registered the service ${undeclared}, which its manifest does not declare.`,
    });
  const handlers = readyMessage.handlers;

  const invoke = Effect.fn("PluginProcess.invoke")(function* (handler: string, input: Json) {
    const fail = (failure: CallFailure) => new PluginCallError({ pluginId, handler, ...failure });
    if (yield* Deferred.isDone(exited)) return yield* fail({ reason: "stopped" });
    if (jsonBytes(input) > options.maxPayloadBytes) return yield* fail({ reason: "too-large" });
    const requestId = nextRequestId++;
    const deferred = Deferred.makeUnsafe<Json, CallFailure>();
    pending.set(requestId, deferred);
    send({ _tag: "Invoke", requestId, handler, input });
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(callTimeout),
      Effect.mapError(fail),
      Effect.flatMap((result) =>
        result._tag === "Some"
          ? Effect.succeed(result.value)
          : Effect.fail(fail({ reason: "timeout" })),
      ),
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
    );
  });

  return { pid: child.pid, handlers, invoke, exited } satisfies PluginProcess;
});
