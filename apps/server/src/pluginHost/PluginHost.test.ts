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
import * as Stream from "effect/Stream";

import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";

const EXAMPLE = `${import.meta.dirname}/../../../../plugin-host-examples/echo-clock`;
const PLUGIN_ID = "example.echo-clock";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-host-" });
  const stateDir = path.join(root, "state");
  const copyExample = Effect.fn("copyExample")(function* (name: string) {
    const directory = path.join(root, name);
    yield* fs.copy(EXAMPLE, directory);
    return directory;
  });
  let spawns = 0;
  const host = yield* PluginHost.make({
    stateDir,
    maxFailures: 3,
    restartBackoff: Duration.millis(1),
    maxRestartBackoff: Duration.millis(1),
    stopGrace: Duration.millis(500),
    spawnProcess: (options) => {
      spawns += 1;
      return spawnPluginProcess(options);
    },
  });
  return { fs, path, root, stateDir, host, copyExample, spawnCount: () => spawns };
});

const call = (host: PluginHost.PluginHost["Service"], input: PluginHostCallInput) =>
  host.call(input);

const entryOf = (snapshot: PluginHostSnapshot, id = PLUGIN_ID) =>
  snapshot.plugins.find((plugin) => plugin.id === id);

/** Resolves on the first snapshot, current or future, that satisfies `predicate`. */
const until = (
  host: PluginHost.PluginHost["Service"],
  predicate: (s: PluginHostSnapshot) => boolean,
) =>
  host.subscribe.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

const isRunning = (snapshot: PluginHostSnapshot, id = PLUGIN_ID) =>
  entryOf(snapshot, id)?.state._tag === "running";

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("PluginHost", () => {
  it.live(
    "starts and stops a plugin with its views and commands, without restarting the server",
    () =>
      Effect.gen(function* () {
        const { host, copyExample } = yield* setup;
        const directory = yield* copyExample("echo");
        yield* call(host, { _tag: "add", path: directory });
        expect((yield* until(host, () => true))?.views).toEqual([]);

        yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });
        const running = yield* until(host, isRunning);
        const pid = entryOf(running!)?.pid;
        expect(running?.views.map((view) => view.viewId)).toEqual(["clock"]);
        expect(running?.commands.map((command) => command.commandId)).toEqual(["echo-now"]);
        expect(pid).toBeDefined();
        expect(pidAlive(pid!)).toBe(true);
        expect(
          yield* call(host, {
            _tag: "invoke",
            pluginId: PLUGIN_ID as never,
            handler: "echo",
            input: { a: 1 },
          }),
        ).toEqual({ value: { a: 1 } });
        const now = yield* call(host, {
          _tag: "invoke",
          pluginId: PLUGIN_ID as never,
          handler: pluginCommandHandler("echo-now"),
          input: null,
        });
        expect(JSON.stringify(now)).toContain("Now: ");

        yield* call(host, { _tag: "disable", pluginId: PLUGIN_ID as never });
        const stopped = yield* until(host, (s) => entryOf(s)?.state._tag === "idle");
        expect(stopped?.views).toEqual([]);
        expect(stopped?.commands).toEqual([]);
        expect(pidAlive(pid!)).toBe(false);
        const refused = yield* call(host, {
          _tag: "invoke",
          pluginId: PLUGIN_ID as never,
          handler: "echo",
          input: null,
        }).pipe(Effect.flip);
        expect(refused.reason).toBe("not-running");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serves settings, storage and view bundles to the plugin and its views", () =>
    Effect.gen(function* () {
      const { host, copyExample } = yield* setup;
      yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
      yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });
      const running = entryOf((yield* until(host, isRunning))!)!;
      const pluginId = PLUGIN_ID as never;

      yield* call(host, { _tag: "setSetting", pluginId, key: "prefix", value: "Tick" });
      const view = yield* call(host, {
        _tag: "invoke",
        pluginId,
        handler: pluginViewHandler("clock", "now"),
        input: null,
      });
      expect(JSON.stringify(view)).toContain("Tick: ");
      const wrongType = yield* call(host, {
        _tag: "setSetting",
        pluginId,
        key: "prefix",
        value: 1,
      }).pipe(Effect.flip);
      expect(wrongType.reason).toBe("invalid-input");

      yield* call(host, {
        _tag: "invoke",
        pluginId,
        handler: "remember",
        input: { key: "k", value: [1] },
      });
      expect(
        yield* call(host, { _tag: "invoke", pluginId, handler: "recall", input: { key: "k" } }),
      ).toEqual({ value: [1] });

      const bundle = yield* call(host, {
        _tag: "readView",
        pluginId,
        viewId: "clock",
        generation: running.generation,
      });
      expect(JSON.stringify(bundle)).toContain("textContent");
      const stale = yield* call(host, {
        _tag: "readView",
        pluginId,
        viewId: "clock",
        generation: running.generation + 1,
      }).pipe(Effect.flip);
      expect(stale.reason).toBe("stale-generation");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reload applies a new manifest title, bumps the generation and asks for consent again",
    () =>
      Effect.gen(function* () {
        const { fs, path, host, copyExample } = yield* setup;
        const directory = yield* copyExample("echo");
        yield* call(host, { _tag: "add", path: directory });
        yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });
        const before = entryOf((yield* until(host, isRunning))!)!;

        const manifestPath = path.join(directory, "t3-plugin.json");
        const manifest = (yield* fs.readFileString(manifestPath)).replace(
          '"title": "Echo Clock"',
          '"title": "Renamed Clock"',
        );
        yield* fs.writeFileString(
          manifestPath,
          manifest.replace('"name": "Echo Clock"', '"name": "Renamed"'),
        );
        yield* call(host, { _tag: "reload", pluginId: PLUGIN_ID as never });
        const reloaded = yield* until(host, (s) => entryOf(s)?.name === "Renamed");
        expect(entryOf(reloaded!)?.consent).toBe("required");
        expect(entryOf(reloaded!)?.state._tag).toBe("idle");

        yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });
        const after = yield* until(host, isRunning);
        expect(after?.views[0]?.title).toBe("Renamed Clock");
        expect(entryOf(after!)!.generation).toBeGreaterThan(before.generation);
        expect(entryOf(after!)!.pid).not.toBe(before.pid);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses bad manifests and leaves a good plugin untouched", () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, host, copyExample } = yield* setup;
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
      yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });
      yield* until(host, isRunning);
      yield* host.call({ _tag: "disable", pluginId: PLUGIN_ID as never });
      yield* until(host, (s) => entryOf(s)?.state._tag === "idle");

      // A hand-edited registry that lists the bad plugins loads them as problems, not as a failure of the host.
      yield* fs.writeFileString(
        path.join(stateDir, "plugins", "registry.json"),
        JSON.stringify([
          { id: PLUGIN_ID, path: good, enabled: true },
          ...Object.entries(badPaths).map(([name, directory]) => ({
            id: `bad.${name}`,
            path: directory,
            enabled: true,
          })),
        ]),
      );
      const second = yield* PluginHost.make({
        stateDir,
        restartBackoff: Duration.millis(1),
        stopGrace: Duration.millis(500),
      });
      const snapshot = yield* until(second, isRunning);
      for (const name of Object.keys(badPaths)) {
        const entry = entryOf(snapshot!, `bad.${name}`);
        expect(entry?.problem).toBeDefined();
        expect(entry?.state._tag).toBe("idle");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "quarantines a plugin whose process is killed three times, and resume starts it again",
    () =>
      Effect.gen(function* () {
        const { host, copyExample } = yield* setup;
        yield* call(host, { _tag: "add", path: yield* copyExample("echo") });
        yield* call(host, { _tag: "enable", pluginId: PLUGIN_ID as never, grantConsent: true });

        for (let kill = 1; kill <= 3; kill += 1) {
          const running = yield* until(host, isRunning);
          process.kill(entryOf(running!)!.pid!, "SIGKILL");
          const after = yield* until(host, (s) => !isRunning(s));
          expect(after?.views).toEqual([]);
          expect(after?.commands).toEqual([]);
          if (kill < 3) expect(entryOf(after!)?.state._tag).toBe("backoff");
        }
        const quarantined = yield* until(host, (s) => entryOf(s)?.state._tag === "quarantined");
        const state = entryOf(quarantined!)!.state;
        expect(state._tag === "quarantined" ? state.failures : 0).toBe(3);

        yield* call(host, { _tag: "resume", pluginId: PLUGIN_ID as never });
        expect(isRunning((yield* until(host, isRunning))!)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("without plugins it starts no process and creates no files", () =>
    Effect.gen(function* () {
      const { fs, path, stateDir, host, spawnCount } = yield* setup;
      const snapshot = yield* until(host, () => true);
      expect(snapshot).toEqual({ plugins: [], views: [], commands: [] });
      expect(spawnCount()).toBe(0);
      expect(yield* fs.exists(path.join(stateDir, "plugins"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
