import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PluginHostCallInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";
import { CHILD } from "./testChild.ts";

const NAMESPACE = "com.jieyuexing.t3code";

const SOURCE = `
export function activate(context) {
  context.handle("put", ({ key, value }) => context.cache.set(key, value));
  context.handle("putBig", ({ key }) => context.cache.set(key, "x".repeat(2 * 1024 * 1024 + 10)));
  context.handle("get", ({ key }) => context.cache.get(key));
  context.handle("drop", ({ key }) => context.cache.delete(key));
  context.handle("both", async () => {
    await context.storage.set("kept", "in storage");
    await context.cache.set("k", "in cache");
    return null;
  });
  context.handle("readBoth", async () => ({ storage: await context.storage.get("kept"), cache: await context.cache.get("k") }));
}
`;

const setup = Effect.fn("setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-cache-host-" });
  const stateDir = path.join(root, "state");
  const host = yield* PluginHost.make({
    stateDir,
    ...CHILD,
    attachmentsDir: path.join(root, "attachments"),
    issueUrl: (attachmentId) =>
      Effect.succeed({ relativeUrl: `/api/assets/test/${attachmentId}`, expiresAt: 1 }),
    maxFailures: 3,
    restartBackoff: Duration.millis(1),
    maxRestartBackoff: Duration.millis(1),
    stopGrace: Duration.millis(500),
    spawnProcess: spawnPluginProcess,
  });
  yield* host.call({ _tag: "setHostEnabled", enabled: true });
  const call = (input: PluginHostCallInput) => host.call(input);
  const addPlugin = Effect.fn("addPlugin")(function* (
    name: string,
    capabilities: ReadonlyArray<string> = [],
  ) {
    const directory = path.join(root, name);
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        extensions: {
          [NAMESPACE]: {
            apiVersion: 1,
            entry: "./index.mjs",
            capabilities,
            inject: [],
            provides: [],
          },
        },
      }),
    );
    yield* fs.writeFileString(path.join(directory, "index.mjs"), SOURCE);
    yield* call({ _tag: "add", path: directory });
    yield* call({ _tag: "enable", pluginId: name as never, grantConsent: true });
    return name;
  });
  const invoke = (name: string, handler: string, input: unknown = null) =>
    call({ _tag: "invoke", pluginId: name as never, handler, input: input as never }).pipe(
      Effect.map((result) => result.value),
    );
  return { fs, path, stateDir, host, call, addPlugin, invoke };
});

describe("plugin cache through the host", () => {
  it.live(
    "a plugin reads and writes its own cache without any capability, apart from other plugins",
    () =>
      Effect.gen(function* () {
        const { addPlugin, invoke } = yield* setup();
        yield* addPlugin("cache.one");
        yield* addPlugin("cache.two");
        expect(yield* invoke("cache.one", "get", { key: "a" })).toBeNull();
        yield* invoke("cache.one", "put", { key: "a", value: { n: 1 } });
        expect(yield* invoke("cache.one", "get", { key: "a" })).toEqual({ n: 1 });
        expect(yield* invoke("cache.two", "get", { key: "a" })).toBeNull();
        yield* invoke("cache.one", "drop", { key: "a" });
        expect(yield* invoke("cache.one", "get", { key: "a" })).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a value over the per-value limit is refused with a sentence the plugin sees", () =>
    Effect.gen(function* () {
      const { addPlugin, invoke } = yield* setup();
      yield* addPlugin("cache.one");
      const failure = yield* invoke("cache.one", "putBig", { key: "big" }).pipe(Effect.flip);
      expect(failure.detail).toContain("too large");
      expect(yield* invoke("cache.one", "get", { key: "big" })).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reports usage per plugin, and clearing the cache leaves storage and settings alone",
    () =>
      Effect.gen(function* () {
        const { addPlugin, invoke, call, fs, path, stateDir } = yield* setup();
        yield* addPlugin("cache.one", ["settings"]);
        yield* addPlugin("cache.two");
        expect((yield* call({ _tag: "cacheUsage" })).value).toEqual({});
        yield* invoke("cache.one", "both");
        yield* invoke("cache.two", "put", { key: "a", value: "x".repeat(1000) });
        const usage = (yield* call({ _tag: "cacheUsage" })).value as Record<string, number>;
        expect(usage["cache.one"]).toBeGreaterThan(0);
        expect(usage["cache.two"]).toBeGreaterThan(1000);

        yield* call({ _tag: "clearCache", pluginId: "cache.one" as never });
        expect(yield* invoke("cache.one", "readBoth")).toEqual({
          storage: "in storage",
          cache: null,
        });
        expect(yield* invoke("cache.two", "get", { key: "a" })).toBe("x".repeat(1000));
        const after = (yield* call({ _tag: "cacheUsage" })).value as Record<string, number>;
        expect(after["cache.one"]).toBeUndefined();
        expect(yield* fs.exists(path.join(stateDir, "plugins", "data", "cache.one.json"))).toBe(
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removing a plugin deletes its cache directory and keeps its data file", () =>
    Effect.gen(function* () {
      const { addPlugin, invoke, call, fs, path, stateDir } = yield* setup();
      yield* addPlugin("cache.one", ["settings"]);
      yield* invoke("cache.one", "both");
      const directory = path.join(stateDir, "plugins", "cache", "cache.one");
      expect(yield* fs.exists(directory)).toBe(true);
      yield* call({ _tag: "remove", pluginId: "cache.one" as never });
      expect(yield* fs.exists(directory)).toBe(false);
      expect(yield* fs.exists(path.join(stateDir, "plugins", "data", "cache.one.json"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
