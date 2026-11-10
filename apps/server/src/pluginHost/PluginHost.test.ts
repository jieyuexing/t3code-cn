import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  pluginCommandHandler,
  pluginViewHandler,
  type PluginHostCallInput,
  type PluginHostSnapshot,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";

const EXAMPLE = `${import.meta.dirname}/../../../../plugin-host-examples/echo-clock`;
const CHILD = {
  command: process.execPath,
  args: [`${import.meta.dirname}/child.mjs`],
} as const;
const PLUGIN_ID = "example.echo-clock";
const pluginId = PLUGIN_ID as never;

type Host = PluginHost.PluginHost["Service"];

const makeOptions = (spawnCounter: { count: number }) => ({
  ...CHILD,
  maxFailures: 3,
  restartBackoff: Duration.millis(1),
  maxRestartBackoff: Duration.millis(1),
  stopGrace: Duration.millis(500),
  spawnProcess: ((options) => {
    spawnCounter.count += 1;
    return spawnPluginProcess(options);
  }) satisfies typeof spawnPluginProcess,
});

const call = (host: Host, input: PluginHostCallInput) => host.call(input);

const entryOf = (snapshot: PluginHostSnapshot, id = PLUGIN_ID) =>
  snapshot.plugins.find((plugin) => plugin.id === id);

/** The snapshot as it is now: the stream starts with the current value. */
const latest = (host: Host) =>
  host.subscribe.pipe(
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

const setup = Effect.fn("setup")(function* (options?: { readonly hostEnabled?: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-host-" });
  const stateDir = path.join(root, "state");
  const copyExample = Effect.fn("copyExample")(function* (name: string) {
    const directory = path.join(root, name);
    yield* fs.copy(EXAMPLE, directory);
    return directory;
  });
  const spawns = { count: 0 };
  const host = yield* PluginHost.make({ stateDir, ...makeOptions(spawns) });
  if (options?.hostEnabled !== false) yield* call(host, { _tag: "setHostEnabled", enabled: true });
  // Every snapshot from now on, in order, so a test waits for a transition instead of polling.
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
  const invoke = (handler: string, input: unknown = null) =>
    call(host, { _tag: "invoke", pluginId, handler, input: input as never });
  return { fs, path, root, stateDir, host, copyExample, spawns, next, invoke };
});

const stateOf = (snapshot: PluginHostSnapshot | undefined) => entryOf(snapshot!)?.state._tag;

const dropViews = (manifestText: string) => {
  const manifest = JSON.parse(manifestText);
  return JSON.stringify({
    ...manifest,
    views: [],
    capabilities: manifest.capabilities.filter((name: string) => name !== "views"),
  });
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("PluginHost", () => {
  it.live("offers views and commands on enable, starts the process on the first call only", () =>
    Effect.gen(function* () {
      const { host, copyExample, spawns, invoke } = yield* setup();
      yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
      expect((yield* latest(host))?.views).toEqual([]);

      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });
      const standby = yield* latest(host);
      expect(stateOf(standby)).toBe("standby");
      expect(entryOf(standby!)?.pid).toBeUndefined();
      expect(standby?.views.map((view) => view.viewId)).toEqual(["clock"]);
      expect(standby?.commands.map((command) => command.commandId)).toEqual(["echo-now"]);
      expect(spawns.count).toBe(0);

      expect(yield* invoke("echo", { a: 1 })).toEqual({ value: { a: 1 } });
      expect(spawns.count).toBe(1);
      const running = yield* latest(host);
      const pid = entryOf(running!)?.pid;
      expect(stateOf(running)).toBe("running");
      expect(pidAlive(pid!)).toBe(true);
      expect(JSON.stringify(yield* invoke(pluginCommandHandler("echo-now")))).toContain("Now: ");
      expect(spawns.count).toBe(1);

      yield* call(host, { _tag: "disable", pluginId });
      const stopped = yield* latest(host);
      expect(stateOf(stopped)).toBe("idle");
      expect([stopped?.views, stopped?.commands]).toEqual([[], []]);
      expect(pidAlive(pid!)).toBe(false);
      const refused = yield* invoke("echo").pipe(Effect.flip);
      expect(refused.reason).toBe("not-running");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("concurrent first calls share one process", () =>
    Effect.gen(function* () {
      const { host, copyExample, spawns, invoke } = yield* setup();
      yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });

      const results = yield* Effect.all([invoke("echo", 1), invoke("echo", 2)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([{ value: 1 }, { value: 2 }]);
      expect(spawns.count).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a failed first start reaches the caller and follows backoff and quarantine", () =>
    Effect.gen(function* () {
      const { fs, path, host, copyExample, spawns, next, invoke } = yield* setup();
      const directory = yield* copyExample("echo");
      yield* fs.writeFileString(
        path.join(directory, "index.mjs"),
        'export function activate() { throw new Error("boom"); }\n',
      );
      yield* call(host, { _tag: "add", path: directory });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });

      for (const failures of [1, 2]) {
        const error = yield* invoke("echo").pipe(Effect.flip);
        expect(error.reason).toBe("call-failed");
        expect(error.detail).toContain("boom");
        const backoff = yield* next((s) => stateOf(s) === "backoff");
        expect(backoff.views).toEqual([]);
        const state = entryOf(backoff)!.state;
        expect(state._tag === "backoff" ? state.failures : 0).toBe(failures);
        yield* next((s) => stateOf(s) === "standby");
      }
      expect((yield* invoke("echo").pipe(Effect.flip)).detail).toContain("boom");
      yield* next((s) => stateOf(s) === "quarantined");
      expect(spawns.count).toBe(3);
      const refused = yield* invoke("echo").pipe(Effect.flip);
      expect([refused.reason, refused.detail]).toEqual([
        "not-running",
        expect.stringContaining("Quarantined"),
      ]);
      expect(spawns.count).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serves settings, storage and view bundles to the plugin and its views", () =>
    Effect.gen(function* () {
      const { host, copyExample, invoke } = yield* setup();
      yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });
      const generation = entryOf((yield* latest(host))!)!.generation;

      // A view's script needs no process, only the activation it was offered under.
      const bundle = yield* call(host, { _tag: "readView", pluginId, viewId: "clock", generation });
      expect(JSON.stringify(bundle)).toContain("textContent");
      const stale = yield* call(host, {
        _tag: "readView",
        pluginId,
        viewId: "clock",
        generation: generation + 1,
      }).pipe(Effect.flip);
      expect(stale.reason).toBe("stale-generation");

      yield* call(host, { _tag: "setSetting", pluginId, key: "prefix", value: "Tick" });
      expect(JSON.stringify(yield* invoke(pluginViewHandler("clock", "now")))).toContain("Tick: ");
      const wrongType = yield* call(host, {
        _tag: "setSetting",
        pluginId,
        key: "prefix",
        value: 1,
      }).pipe(Effect.flip);
      expect(wrongType.reason).toBe("invalid-input");

      yield* invoke("remember", { key: "k", value: [1] });
      expect(yield* invoke("recall", { key: "k" })).toEqual({ value: [1] });

      // Starting the process leaves the offered views valid.
      expect(entryOf((yield* latest(host))!)!.generation).toBe(generation);
      yield* call(host, { _tag: "readView", pluginId, viewId: "clock", generation });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reload applies a new title and keeps the consent, back in standby", () =>
    Effect.gen(function* () {
      const { fs, path, host, copyExample, spawns, invoke } = yield* setup();
      const directory = yield* copyExample("echo");
      yield* call(host, { _tag: "add", path: directory });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });
      yield* invoke("echo");
      const before = entryOf((yield* latest(host))!)!;
      expect(spawns.count).toBe(1);

      const manifestPath = path.join(directory, "t3-plugin.json");
      const manifest = (yield* fs.readFileString(manifestPath))
        .replace('"title": "Echo Clock"', '"title": "Renamed Clock"')
        .replace('"name": "Echo Clock"', '"name": "Renamed"');
      yield* fs.writeFileString(manifestPath, manifest);
      yield* call(host, { _tag: "reload", pluginId });
      const reloaded = yield* latest(host);
      const entry = entryOf(reloaded!)!;
      expect([entry.name, entry.consent, entry.state._tag]).toEqual([
        "Renamed",
        "granted",
        "standby",
      ]);
      expect(entry.pid).toBeUndefined();
      expect(entry.generation).toBeGreaterThan(before.generation);
      expect(reloaded?.views[0]?.title).toBe("Renamed Clock");
      expect(reloaded?.views[0]?.generation).toBe(entry.generation);
      expect(spawns.count).toBe(1);

      yield* invoke("echo");
      expect(spawns.count).toBe(2);
      expect(entryOf((yield* latest(host))!)!.pid).not.toBe(before.pid);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reload asks for consent again when the entry or the capabilities change", () =>
    Effect.gen(function* () {
      const { fs, path, host, copyExample } = yield* setup();
      const directory = yield* copyExample("echo");
      yield* call(host, { _tag: "add", path: directory });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });
      const manifestPath = path.join(directory, "t3-plugin.json");
      const original = yield* fs.readFileString(manifestPath);
      const reloadWith = Effect.fn("reloadWith")(function* (text: string) {
        yield* fs.writeFileString(manifestPath, text);
        yield* call(host, { _tag: "reload", pluginId });
        return entryOf((yield* latest(host))!)!;
      });

      yield* fs.copyFile(path.join(directory, "index.mjs"), path.join(directory, "other.mjs"));
      const entryChanged = yield* reloadWith(original.replace('"index.mjs"', '"other.mjs"'));
      expect([entryChanged.consent, entryChanged.state._tag]).toEqual(["required", "idle"]);

      const capabilitiesChanged = yield* reloadWith(dropViews(original));
      expect(capabilitiesChanged.problem).toBeUndefined();
      expect([capabilitiesChanged.consent, capabilitiesChanged.state._tag]).toEqual([
        "required",
        "idle",
      ]);

      const restored = yield* reloadWith(original);
      expect([restored.consent, restored.state._tag]).toEqual(["granted", "standby"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses bad manifests and leaves a good plugin untouched", () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, host, copyExample } = yield* setup();
      const good = yield* copyExample("good");
      const manifestOf = (directory: string) => path.join(directory, "t3-plugin.json");
      const mutate = Effect.fn("mutate")(function* (
        name: string,
        change: (text: string) => string,
      ) {
        const directory = yield* copyExample(name);
        yield* fs.writeFileString(
          manifestOf(directory),
          change(yield* fs.readFileString(manifestOf(directory))),
        );
        return directory;
      });
      const badPaths = {
        traversal: yield* mutate("traversal", (text) => text.replace('"index.mjs"', '"../x.js"')),
        capability: yield* mutate("capability", (text) =>
          text.replace('"views", "x.commands"', '"views", "x.commands", "tools"'),
        ),
        oversize: yield* mutate("oversize", (text) =>
          text.replace(
            '"version": "0.1.0"',
            `"version": "0.1.0", "padding": "${"x".repeat(70 * 1024)}"`,
          ),
        ),
        injection: yield* mutate("injection", (text) =>
          text.replace(
            '"inject": ["settings", "log", "handle"]',
            '"inject": ["settings", "database"]',
          ),
        ),
      };
      const expectedProblem = {
        traversal: "entry",
        capability: "does not support tools",
        oversize: "64 KiB",
        injection: "database",
      } as const;
      for (const [name, directory] of Object.entries(badPaths)) {
        const error = yield* call(host, { _tag: "add", path: directory }).pipe(Effect.flip);
        expect([name, error.reason]).toEqual([name, "invalid-plugin"]);
        expect(error.detail).toContain(expectedProblem[name as keyof typeof expectedProblem]);
      }

      yield* call(host, { _tag: "add", path: good });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });
      yield* call(host, { _tag: "disable", pluginId });

      // A hand-edited registry that lists the bad plugins loads them as problems, not as a failure of the host.
      yield* fs.writeFileString(
        path.join(stateDir, "plugins", "registry.json"),
        JSON.stringify({
          enabled: true,
          plugins: [
            { id: PLUGIN_ID, path: good, enabled: true },
            ...Object.entries(badPaths).map(([name, directory]) => ({
              id: `bad.${name}`,
              path: directory,
              enabled: true,
            })),
          ],
        }),
      );
      const second = yield* PluginHost.make({
        stateDir,
        ...CHILD,
        stopGrace: Duration.millis(500),
      });
      const snapshot = yield* latest(second);
      expect(stateOf(snapshot)).toBe("standby");
      for (const name of Object.keys(badPaths)) {
        const entry = entryOf(snapshot!, `bad.${name}`);
        expect(entry?.problem).toBeDefined();
        expect(entry?.state._tag).toBe("idle");
      }
      expect(yield* second.call({ _tag: "invoke", pluginId, handler: "echo", input: 7 })).toEqual({
        value: 7,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("the host switch gates parsing and processes, and closing it stops everything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-switch-" });
      const stateDir = path.join(root, "state");
      const copy = Effect.fn("copy")(function* (name: string, change?: (text: string) => string) {
        const directory = path.join(root, name);
        yield* fs.copy(EXAMPLE, directory);
        if (change) {
          const manifestPath = path.join(directory, "t3-plugin.json");
          yield* fs.writeFileString(manifestPath, change(yield* fs.readFileString(manifestPath)));
        }
        return directory;
      });
      const good = yield* copy("good");
      const bad = yield* copy("bad", (text) => text.replace('"index.mjs"', '"../x.js"'));

      // Record the consent for the good plugin, then hand-edit the registry to switch off with both listed.
      const first = yield* PluginHost.make({ stateDir, ...CHILD });
      yield* call(first, { _tag: "setHostEnabled", enabled: true });
      yield* call(first, { _tag: "add", path: good });
      yield* call(first, { _tag: "enable", pluginId, grantConsent: true });
      yield* fs.writeFileString(
        path.join(stateDir, "plugins", "registry.json"),
        JSON.stringify({
          enabled: false,
          plugins: [
            { id: PLUGIN_ID, path: good, enabled: true },
            { id: "bad.entry", path: bad, enabled: true },
          ],
        }),
      );

      let manifestReads = 0;
      const countingFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: (file, ...rest) => {
          if (file.endsWith("t3-plugin.json")) manifestReads += 1;
          return fs.readFileString(file, ...rest);
        },
      };
      const spawns = { count: 0 };
      const host = yield* PluginHost.make({ stateDir, ...makeOptions(spawns) }).pipe(
        Effect.provideService(FileSystem.FileSystem, countingFs),
      );
      expect(yield* latest(host)).toEqual({
        hostEnabled: false,
        registered: 2,
        plugins: [],
        views: [],
        commands: [],
      });
      const refused = yield* call(host, { _tag: "add", path: good }).pipe(Effect.flip);
      expect(refused.reason).toBe("host-disabled");
      expect([manifestReads, spawns.count]).toEqual([0, 0]);

      yield* call(host, { _tag: "setHostEnabled", enabled: true });
      const on = yield* latest(host);
      expect(manifestReads).toBeGreaterThan(0);
      expect(on?.hostEnabled).toBe(true);
      expect(entryOf(on!, "bad.entry")?.problem).toBeDefined();
      expect(stateOf(on)).toBe("standby");
      expect(on?.views).toHaveLength(1);
      expect(spawns.count).toBe(0);
      const echoed = yield* call(host, { _tag: "invoke", pluginId, handler: "echo", input: 5 });
      expect(echoed).toEqual({ value: 5 });
      const pid = entryOf((yield* latest(host))!)!.pid!;
      expect(pidAlive(pid)).toBe(true);

      yield* call(host, { _tag: "setHostEnabled", enabled: false });
      expect(pidAlive(pid)).toBe(false);
      expect(yield* latest(host)).toEqual({
        hostEnabled: false,
        registered: 2,
        plugins: [],
        views: [],
        commands: [],
      });
      const afterOff = yield* call(host, {
        _tag: "invoke",
        pluginId,
        handler: "echo",
        input: 5,
      }).pipe(Effect.flip);
      expect(afterOff.reason).toBe("host-disabled");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("kills three times and the plugin is quarantined, then resume offers it again", () =>
    Effect.gen(function* () {
      const { host, copyExample, next, invoke } = yield* setup();
      yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
      yield* call(host, { _tag: "enable", pluginId, grantConsent: true });

      for (const kill of [1, 2, 3]) {
        yield* invoke("echo");
        const running = yield* latest(host);
        process.kill(entryOf(running!)!.pid!, "SIGKILL");
        const after = yield* next((s) => ["backoff", "quarantined"].includes(stateOf(s) ?? ""));
        expect([after.views, after.commands]).toEqual([[], []]);
        if (kill < 3) {
          expect(stateOf(after)).toBe("backoff");
          yield* next((s) => stateOf(s) === "standby");
        }
      }
      const state = entryOf((yield* latest(host))!)!.state;
      expect(state._tag === "quarantined" ? state.failures : 0).toBe(3);

      yield* call(host, { _tag: "resume", pluginId });
      expect(stateOf(yield* latest(host))).toBe("standby");
      expect(yield* invoke("echo", 1)).toEqual({ value: 1 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("without plugins it starts no process and creates no files", () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, host, spawns } = yield* setup({ hostEnabled: false });
      expect(yield* latest(host)).toEqual({
        hostEnabled: false,
        registered: 0,
        plugins: [],
        views: [],
        commands: [],
      });
      expect(spawns.count).toBe(0);
      expect(yield* fs.exists(path.join(stateDir, "plugins"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
