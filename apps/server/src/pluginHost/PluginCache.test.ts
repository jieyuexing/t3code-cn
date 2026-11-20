import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makePluginCache } from "./PluginCache.ts";

const ID = "example.cache";

const setup = (limits?: { readonly maxBytes?: number; readonly maxValueBytes?: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-cache-" });
    const directory = path.join(root, "plugins", "cache", ID);
    const open = () => makePluginCache(root, limits);
    return { fs, path, root, directory, open, cache: yield* open() };
  });

const text = (size: number) => "x".repeat(size);

describe("plugin cache", () => {
  it.effect("round-trips values, answers null for a missing key, and deletes one key", () =>
    Effect.gen(function* () {
      const { cache } = yield* setup();
      expect(yield* cache.get(ID, "a")).toBeNull();
      yield* cache.set(ID, "a", { n: 1, list: ["x"] });
      expect(yield* cache.get(ID, "a")).toEqual({ n: 1, list: ["x"] });
      yield* cache.set(ID, "a", "replaced");
      expect(yield* cache.get(ID, "a")).toBe("replaced");
      yield* cache.delete(ID, "a");
      expect(yield* cache.get(ID, "a")).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps each plugin's cache apart and writes one file per key", () =>
    Effect.gen(function* () {
      const { cache, fs, directory } = yield* setup();
      yield* cache.set(ID, "k1", 1);
      yield* cache.set(ID, "k2", 2);
      yield* cache.set("example.other", "k1", "other");
      expect(yield* cache.get("example.other", "k1")).toBe("other");
      expect(yield* cache.get(ID, "k1")).toBe(1);
      expect(
        (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a value over the per-value limit and leaves the old value alone", () =>
    Effect.gen(function* () {
      const { cache } = yield* setup({ maxValueBytes: 100 });
      yield* cache.set(ID, "a", "small");
      const failure = yield* cache.set(ID, "a", text(200)).pipe(Effect.flip);
      expect(failure).toContain("too large");
      expect(yield* cache.get(ID, "a")).toBe("small");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("evicts the least recently used entries when the plugin goes over its total", () =>
    Effect.gen(function* () {
      const { cache } = yield* setup({ maxBytes: 1000 });
      yield* cache.set(ID, "a", text(300));
      yield* cache.set(ID, "b", text(300));
      yield* cache.set(ID, "c", text(300));
      // Reading `a` makes `b` the oldest.
      expect(yield* cache.get(ID, "a")).not.toBeNull();
      yield* cache.set(ID, "d", text(300));
      expect(yield* cache.get(ID, "b")).toBeNull();
      expect(yield* cache.get(ID, "a")).not.toBeNull();
      expect(yield* cache.get(ID, "c")).not.toBeNull();
      expect(yield* cache.get(ID, "d")).not.toBeNull();
      expect((yield* cache.usage())[ID]).toBeLessThanOrEqual(1000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rebuilds its index from the directory after a restart, oldest file first", () =>
    Effect.gen(function* () {
      const { cache, open, fs, path, directory } = yield* setup({ maxBytes: 1000 });
      for (const key of ["a", "b", "c"]) yield* cache.set(ID, key, text(300));
      // The restart sees only file times: make `b` the oldest, then `a`, then `c`.
      const stamps: Record<string, number> = { b: 1_000, a: 2_000, c: 3_000 };
      for (const name of yield* fs.readDirectory(directory)) {
        const { key } = JSON.parse(yield* fs.readFileString(path.join(directory, name))) as {
          key: string;
        };
        yield* fs.utimes(path.join(directory, name), stamps[key]!, stamps[key]!);
      }
      const restarted = yield* open();
      expect((yield* restarted.usage())[ID]).toBeGreaterThan(900);
      yield* restarted.set(ID, "d", text(300));
      expect(yield* restarted.get(ID, "b")).toBeNull();
      for (const key of ["a", "c", "d"]) expect(yield* restarted.get(ID, key)).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores and removes half-written temporary files", () =>
    Effect.gen(function* () {
      const { cache, fs, path, directory, open } = yield* setup();
      yield* cache.set(ID, "a", "kept");
      yield* fs.writeFileString(path.join(directory, "0123456789abcdef.json.9f3a.tmp"), text(500));
      const restarted = yield* open();
      expect((yield* restarted.usage())[ID]).toBeLessThan(200);
      expect(yield* restarted.get(ID, "a")).toBe("kept");
      expect((yield* fs.readDirectory(directory)).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("clear removes the plugin's directory and nothing else", () =>
    Effect.gen(function* () {
      const { cache, fs, directory } = yield* setup();
      yield* cache.set(ID, "a", 1);
      yield* cache.set("example.other", "a", 2);
      yield* cache.clear(ID);
      expect(yield* fs.exists(directory)).toBe(false);
      expect(yield* cache.get(ID, "a")).toBeNull();
      expect(yield* cache.get("example.other", "a")).toBe(2);
      expect((yield* cache.usage())[ID]).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a damaged file as a miss", () =>
    Effect.gen(function* () {
      const { cache, fs, path, directory } = yield* setup();
      yield* cache.set(ID, "a", "ok");
      const [name] = yield* fs.readDirectory(directory);
      yield* fs.writeFileString(path.join(directory, name!), "{not json");
      expect(yield* cache.get(ID, "a")).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
