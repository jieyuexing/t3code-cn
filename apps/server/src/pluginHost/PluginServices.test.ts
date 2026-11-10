import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PluginHostCallInput, PluginHostSnapshot } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";

const EXAMPLES = `${import.meta.dirname}/../../../../plugin-host-examples`;
const NAMESPACE = "com.jieyuexing.t3code";
const CLOCK = "example.echo-clock";
const GREETER = "example.greeter";

type Host = PluginHost.PluginHost["Service"];

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const entryOf = (snapshot: PluginHostSnapshot | undefined, id: string) =>
  snapshot?.plugins.find((plugin) => plugin.id === id);

const latest = (host: Host) =>
  host.subscribe.pipe(
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

const PING = [{ name: "ping" }];

/** A plugin directory whose service methods are all `ping`, with a handler that calls another plugin's service. */
const pluginSource = (provides: ReadonlyArray<string>) => `
export function activate(context) {
  ${provides.map((service) => `context.provide(${JSON.stringify(service)}, { ping: () => ${JSON.stringify(service)} });`).join("\n  ")}
  context.handle("echo", (input) => input);
  context.handle("call", ({ service }) => context.services[service].ping());
}
`;

const setup = Effect.fn("setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-services-" });
  const spawns = { count: 0 };
  const transitions: Array<string> = [];
  const host = yield* PluginHost.make({
    stateDir: path.join(root, "state"),
    command: process.execPath,
    args: [`${import.meta.dirname}/child.mjs`],
    attachmentsDir: path.join(root, "attachments"),
    issueUrl: (attachmentId) =>
      Effect.succeed({ relativeUrl: `/api/assets/test/${attachmentId}`, expiresAt: 1 }),
    maxFailures: 3,
    restartBackoff: Duration.millis(1),
    maxRestartBackoff: Duration.millis(1),
    stopGrace: Duration.millis(500),
    spawnProcess: (options) => {
      spawns.count += 1;
      return spawnPluginProcess(options);
    },
    onTransition: (pluginId, action) => transitions.push(`${action} ${pluginId}`),
  });
  yield* host.call({ _tag: "setHostEnabled", enabled: true });
  const snapshots = yield* Queue.unbounded<PluginHostSnapshot>();
  yield* host.subscribe.pipe(
    Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
    Effect.forkScoped({ startImmediately: true }),
  );
  const next = Effect.fn("next")(function* (predicate: (snapshot: PluginHostSnapshot) => boolean) {
    while (true) {
      const snapshot = yield* Queue.take(snapshots);
      if (predicate(snapshot)) return snapshot;
    }
  });
  const call = (input: PluginHostCallInput) => host.call(input);
  const enable = (id: string) =>
    call({ _tag: "enable", pluginId: id as never, grantConsent: true });
  const invoke = (id: string, handler: string, input: unknown = null) =>
    call({ _tag: "invoke", pluginId: id as never, handler, input: input as never });
  const addExample = Effect.fn("addExample")(function* (example: string) {
    const directory = path.join(root, example);
    yield* fs.copy(`${EXAMPLES}/${example}`, directory);
    yield* call({ _tag: "add", path: directory });
    return directory;
  });
  /** Adds a generated plugin that provides and injects services. */
  const addGenerated = Effect.fn("addGenerated")(function* (
    name: string,
    spec: {
      readonly provides?: ReadonlyArray<string>;
      readonly inject?: ReadonlyArray<string>;
      readonly source?: string;
      readonly declares?: ReadonlyArray<string>;
    } = {},
  ) {
    const directory = path.join(root, name);
    yield* fs.makeDirectory(directory);
    const provides = spec.provides ?? [];
    yield* fs.writeFileString(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        extensions: {
          [NAMESPACE]: {
            apiVersion: 1,
            entry: "./index.mjs",
            inject: spec.inject ?? [],
            provides: (spec.declares ?? provides).map((service) => ({
              name: service,
              methods: PING,
            })),
          },
        },
      }),
    );
    yield* fs.writeFileString(
      path.join(directory, "index.mjs"),
      spec.source ?? pluginSource(provides),
    );
    yield* call({ _tag: "add", path: directory });
    return directory;
  });
  return { host, spawns, transitions, next, call, enable, invoke, addExample, addGenerated };
});

const kill = (pid: number) => process.kill(pid, "SIGKILL");

describe("plugin services", () => {
  it.live(
    "a dependent waits for its service, starts when it appears, and calls it across processes",
    () =>
      Effect.gen(function* () {
        const { host, spawns, enable, invoke, addExample } = yield* setup();
        yield* addExample("greeter");
        yield* addExample("echo-clock");

        yield* enable(GREETER);
        const waiting = yield* latest(host);
        const greeter = entryOf(waiting, GREETER)!;
        expect(greeter.state._tag).toBe("waiting");
        expect(greeter.waitingFor).toEqual(["example.clock"]);
        expect(greeter.pid).toBeUndefined();
        expect([waiting?.views, waiting?.commands]).toEqual([[], []]);
        expect(spawns.count).toBe(0);

        yield* enable(CLOCK);
        const standby = yield* latest(host);
        expect(entryOf(standby, GREETER)?.state._tag).toBe("standby");
        expect(entryOf(standby, GREETER)?.waitingFor).toEqual([]);
        expect(standby?.views.map((view) => view.viewId).toSorted()).toEqual(["clock", "greeting"]);
        expect(standby?.services).toEqual([
          { name: "example.clock", provider: CLOCK, available: true },
        ]);
        expect(spawns.count).toBe(0);

        const greeting = yield* invoke(GREETER, "greet", { name: "Ada" });
        expect(JSON.stringify(greeting.value)).toContain("Hello, Ada!");
        expect(JSON.stringify(greeting.value)).toContain("Now: ");
        expect(spawns.count).toBe(2);
        const running = yield* latest(host);
        expect([
          entryOf(running, GREETER)?.state._tag,
          entryOf(running, CLOCK)?.state._tag,
        ]).toEqual(["running", "running"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stopping the provider stops the dependent, and bringing it back restores it", () =>
    Effect.gen(function* () {
      const { host, spawns, transitions, call, enable, invoke, addExample } = yield* setup();
      yield* addExample("greeter");
      yield* addExample("echo-clock");
      yield* enable(CLOCK);
      yield* enable(GREETER);
      yield* invoke(GREETER, "greet", { name: "Ada" });
      const before = yield* latest(host);
      const greeterPid = entryOf(before, GREETER)!.pid!;
      expect(pidAlive(greeterPid)).toBe(true);
      transitions.length = 0;

      yield* call({ _tag: "disable", pluginId: CLOCK as never });
      const off = yield* latest(host);
      expect(pidAlive(greeterPid)).toBe(false);
      expect(entryOf(off, GREETER)?.state._tag).toBe("waiting");
      expect(entryOf(off, GREETER)?.waitingFor).toEqual(["example.clock"]);
      expect(transitions).toEqual([`stop ${GREETER}`, `stop ${CLOCK}`]);
      // No entry point of the dependent is left in the snapshot.
      expect(off?.views.filter((view) => view.pluginId === GREETER)).toEqual([]);
      expect(off?.commands.filter((command) => command.pluginId === GREETER)).toEqual([]);
      expect(off?.services).toEqual([]);
      const refused = yield* invoke(GREETER, "greet", { name: "Ada" }).pipe(Effect.flip);
      expect(refused.reason).toBe("not-running");
      const spawned = spawns.count;

      yield* enable(CLOCK);
      const back = yield* latest(host);
      expect(entryOf(back, GREETER)?.state._tag).toBe("standby");
      expect(back?.views.some((view) => view.pluginId === GREETER)).toBe(true);
      expect(JSON.stringify((yield* invoke(GREETER, "greet", { name: "Bo" })).value)).toContain(
        "Hello, Bo!",
      );
      expect(spawns.count).toBe(spawned + 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reloading the provider stops the dependent first and starts it again after", () =>
    Effect.gen(function* () {
      const { host, transitions, call, enable, addExample } = yield* setup();
      yield* addExample("greeter");
      yield* addExample("echo-clock");
      yield* enable(CLOCK);
      yield* enable(GREETER);
      const before = yield* latest(host);
      transitions.length = 0;

      yield* call({ _tag: "reload", pluginId: CLOCK as never });
      const after = yield* latest(host);
      expect(transitions).toEqual([
        `stop ${GREETER}`,
        `stop ${CLOCK}`,
        `start ${CLOCK}`,
        `start ${GREETER}`,
      ]);
      expect(entryOf(after, GREETER)?.generation).toBe(entryOf(before, GREETER)!.generation + 1);
      expect(entryOf(after, CLOCK)?.generation).toBe(entryOf(before, CLOCK)!.generation + 1);
      expect(entryOf(after, GREETER)?.state._tag).toBe("standby");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a quarantined provider takes its dependent down until it is resumed", () =>
    Effect.gen(function* () {
      const { host, call, next, enable, invoke, addExample } = yield* setup();
      yield* addExample("greeter");
      yield* addExample("echo-clock");
      yield* enable(CLOCK);
      yield* enable(GREETER);

      for (const attempt of [1, 2, 3]) {
        yield* invoke(CLOCK, "echo");
        kill(entryOf(yield* latest(host), CLOCK)!.pid!);
        const after = yield* next((s) =>
          ["backoff", "quarantined"].includes(entryOf(s, CLOCK)?.state._tag ?? ""),
        );
        if (attempt < 3) {
          // One crash leaves the service available, so the dependent keeps running.
          expect(entryOf(after, GREETER)?.state._tag).toBe("standby");
          yield* next((s) => entryOf(s, CLOCK)?.state._tag === "standby");
        }
      }
      const waiting = yield* next((s) => entryOf(s, GREETER)?.state._tag === "waiting");
      expect(entryOf(waiting, GREETER)?.waitingFor).toEqual(["example.clock"]);
      expect(waiting.services).toEqual([
        { name: "example.clock", provider: CLOCK, available: false },
      ]);

      yield* call({ _tag: "resume", pluginId: CLOCK as never });
      const resumed = yield* latest(host);
      expect([entryOf(resumed, CLOCK)?.state._tag, entryOf(resumed, GREETER)?.state._tag]).toEqual([
        "standby",
        "standby",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "a provider that crashes once but is not quarantined keeps its dependent, and the next call revives it",
    () =>
      Effect.gen(function* () {
        const { host, next, enable, invoke, addExample } = yield* setup();
        yield* addExample("greeter");
        yield* addExample("echo-clock");
        yield* enable(CLOCK);
        yield* enable(GREETER);
        yield* invoke(GREETER, "greet", { name: "Ada" });
        const running = yield* latest(host);
        const greeterPid = entryOf(running, GREETER)!.pid;
        const clockPid = entryOf(running, CLOCK)!.pid!;

        kill(clockPid);
        yield* next((s) => entryOf(s, CLOCK)?.state._tag === "backoff");
        const standby = yield* next((s) => entryOf(s, CLOCK)?.state._tag === "standby");
        expect(entryOf(standby, GREETER)?.state._tag).toBe("running");
        expect(entryOf(standby, GREETER)?.pid).toBe(greeterPid);

        expect(JSON.stringify((yield* invoke(GREETER, "greet", { name: "Bo" })).value)).toContain(
          "Hello, Bo!",
        );
        expect(entryOf(yield* latest(host), CLOCK)?.pid).not.toBe(clockPid);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts a chain of dependencies upstream first and stops it downstream first", () =>
    Effect.gen(function* () {
      const { host, transitions, call, enable, addGenerated } = yield* setup();
      yield* addGenerated("chain.a", { provides: ["chain.a-service"] });
      yield* addGenerated("chain.b", {
        inject: ["chain.a-service"],
        provides: ["chain.b-service"],
      });
      yield* addGenerated("chain.c", { inject: ["chain.b-service"] });

      yield* enable("chain.c");
      yield* enable("chain.b");
      expect(transitions).toEqual([]);
      yield* enable("chain.a");
      expect(transitions).toEqual(["start chain.a", "start chain.b", "start chain.c"]);
      const up = yield* latest(host);
      expect(up?.plugins.map((plugin) => plugin.state._tag)).toEqual([
        "standby",
        "standby",
        "standby",
      ]);

      transitions.length = 0;
      yield* call({ _tag: "disable", pluginId: "chain.a" as never });
      expect(transitions).toEqual(["stop chain.c", "stop chain.b", "stop chain.a"]);
      const down = yield* latest(host);
      expect(entryOf(down, "chain.b")?.waitingFor).toEqual(["chain.a-service"]);
      expect(entryOf(down, "chain.c")?.waitingFor).toEqual(["chain.b-service"]);

      transitions.length = 0;
      yield* call({ _tag: "setHostEnabled", enabled: false });
      yield* call({ _tag: "setHostEnabled", enabled: true });
      yield* enable("chain.a");
      expect(transitions).toEqual(["start chain.a", "start chain.b", "start chain.c"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("plugins that depend on each other wait with a cycle reason and never start", () =>
    Effect.gen(function* () {
      const { host, spawns, transitions, enable, addGenerated } = yield* setup();
      yield* addGenerated("cycle.x", {
        provides: ["cycle.x-service"],
        inject: ["cycle.y-service"],
      });
      yield* addGenerated("cycle.y", {
        provides: ["cycle.y-service"],
        inject: ["cycle.x-service"],
      });
      yield* enable("cycle.x");
      yield* enable("cycle.y");

      const snapshot = yield* latest(host);
      for (const id of ["cycle.x", "cycle.y"]) {
        const entry = entryOf(snapshot, id)!;
        expect(entry.state._tag).toBe("waiting");
        expect(entry.state._tag === "waiting" ? entry.state.reason : "").toContain(
          "dependency cycle",
        );
        expect(entry.waitingFor.length).toBe(1);
      }
      expect([spawns.count, transitions]).toEqual([0, []]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a second provider of a service is refused and the first is unaffected", () =>
    Effect.gen(function* () {
      const { host, enable, invoke, addExample, addGenerated } = yield* setup();
      yield* addExample("echo-clock");
      yield* addGenerated("twin.clock", { provides: ["example.clock"] });
      yield* enable(CLOCK);

      const refused = yield* enable("twin.clock").pipe(Effect.flip);
      expect([refused.reason, refused.detail]).toEqual([
        "service-conflict",
        expect.stringContaining(CLOCK),
      ]);
      const snapshot = yield* latest(host);
      expect(entryOf(snapshot, "twin.clock")?.enabled).toBe(false);
      expect(entryOf(snapshot, CLOCK)?.state._tag).toBe("standby");
      expect(snapshot?.services).toEqual([
        { name: "example.clock", provider: CLOCK, available: true },
      ]);
      expect(yield* invoke(CLOCK, "echo", 1)).toEqual({ value: 1 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "the host refuses calls to services a plugin did not declare, before they reach the provider",
    () =>
      Effect.gen(function* () {
        const { host, spawns, enable, invoke, addExample, addGenerated } = yield* setup();
        yield* addExample("echo-clock");
        // Talks to the host over the raw IPC channel, as a plugin that bypasses `context.services` would.
        const probeSource = `
export function activate(context) {
  context.handle("probe", ({ service, method }) => new Promise((resolve) => {
    const requestId = 9000;
    const listener = (message) => {
      if (message.requestId !== requestId) return;
      process.off("message", listener);
      resolve({ tag: message._tag, message: message.message ?? null });
    };
    process.on("message", listener);
    process.send({ _tag: "HostCall", requestId, method: "service.call", input: { service, method, input: null } });
  }));
}`;
        yield* addGenerated("rogue.probe", { inject: ["example.clock"], source: probeSource });
        yield* addGenerated("rogue.outsider", { source: probeSource });
        yield* enable(CLOCK);
        yield* enable("rogue.probe");
        yield* enable("rogue.outsider");

        const probe = (id: string, service: string, method: string) =>
          invoke(id, "probe", { service, method }).pipe(
            Effect.map((result) => result.value as { tag: string; message: string | null }),
          );
        // The service exists and is available, but this plugin never declared it.
        const outsider = yield* probe("rogue.outsider", "example.clock", "now");
        expect(outsider.tag).toBe("HostCallFailed");
        expect(outsider.message).toContain("does not declare a dependency");
        const notInjected = yield* probe("rogue.probe", "example.other", "now");
        expect(notInjected.message).toContain("does not declare a dependency");
        const undeclared = yield* probe("rogue.probe", "example.clock", "nope");
        expect(undeclared.tag).toBe("HostCallFailed");
        expect(undeclared.message).toContain("has no method nope");
        // Only the two probing plugins started; the provider never saw a call.
        expect(spawns.count).toBe(2);
        expect(entryOf(yield* latest(host), CLOCK)?.state._tag).toBe("standby");

        // The same channel does reach the provider when the call is allowed.
        const allowed = yield* probe("rogue.probe", "example.clock", "now");
        expect(allowed.tag).toBe("HostCallSucceeded");
        expect(spawns.count).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a plugin must register exactly the services its manifest declares", () =>
    Effect.gen(function* () {
      const { enable, invoke, addGenerated } = yield* setup();
      yield* addGenerated("bad.unregistered", {
        declares: ["bad.service"],
        source: 'export function activate(context) { context.handle("echo", (input) => input); }',
      });
      yield* addGenerated("bad.undeclared", {
        source:
          'export function activate(context) { context.provide("bad.extra", { ping: () => 1 }); }',
      });
      for (const [id, expected] of [
        ["bad.unregistered", "did not register it with context.provide"],
        ["bad.undeclared", "does not declare"],
      ] as const) {
        yield* enable(id);
        const error = yield* invoke(id, "echo").pipe(Effect.flip);
        expect([id, error.reason, error.detail]).toEqual([
          id,
          "call-failed",
          expect.stringContaining(expected),
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
