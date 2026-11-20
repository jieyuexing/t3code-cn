import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makePluginStore } from "./PluginStore.ts";

const ID = "example.store";

/** A file system whose data-file reads are counted and whose renames can be made to fail. */
const setup = Effect.gen(function* () {
  const real = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* real.makeTempDirectoryScoped({ prefix: "t3-plugin-store-" });
  const state = { reads: 0, failRename: false };
  const fs: FileSystem.FileSystem = {
    ...real,
    readFileString: (file, encoding) =>
      Effect.suspend(() => {
        state.reads += 1;
        return real.readFileString(file, encoding);
      }),
    rename: (from, to) =>
      state.failRename ? Effect.die(new Error("rename failed")) : real.rename(from, to),
  };
  const store = yield* makePluginStore(root).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  return { real, state, store, file: path.join(root, "plugins", "data", `${ID}.json`) };
});

const data = (value: string) => ({ settings: {}, storage: { key: value } });

describe("plugin store data cache", () => {
  it.effect("reads an unchanged data file once", () =>
    Effect.gen(function* () {
      const { store, state, real, file } = yield* setup;
      yield* real.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      yield* real.writeFileString(file, JSON.stringify(data("a")));
      expect(yield* store.readData(ID)).toEqual(data("a"));
      expect(yield* store.readData(ID)).toEqual(data("a"));
      expect(yield* store.readData(ID)).toEqual(data("a"));
      expect(state.reads).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the new value after a write", () =>
    Effect.gen(function* () {
      const { store, state } = yield* setup;
      yield* store.writeData(ID, data("a"));
      expect(yield* store.readData(ID)).toEqual(data("a"));
      yield* store.writeData(ID, data("b"));
      expect(yield* store.readData(ID)).toEqual(data("b"));
      expect(state.reads).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sees a file changed or deleted outside the store", () =>
    Effect.gen(function* () {
      const { store, real, file } = yield* setup;
      yield* store.writeData(ID, data("a"));
      expect(yield* store.readData(ID)).toEqual(data("a"));
      yield* real.writeFileString(file, JSON.stringify(data("a longer value")));
      expect(yield* store.readData(ID)).toEqual(data("a longer value"));
      // Same size, different mtime: only the mtime tells the two files apart.
      yield* real.writeFileString(file, JSON.stringify(data("a longer valuf")));
      yield* real.utimes(file, 1_000, 1_000);
      expect(yield* store.readData(ID)).toEqual(data("a longer valuf"));
      yield* real.remove(file);
      expect(yield* store.readData(ID)).toEqual({ settings: {}, storage: {} });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not cache a file that does not fit the schema", () =>
    Effect.gen(function* () {
      const { store, real, file, state } = yield* setup;
      yield* real.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
      yield* real.writeFileString(file, JSON.stringify({ storage: 1 }));
      expect(yield* store.readData(ID)).toEqual({ settings: {}, storage: {} });
      const reads = state.reads;
      expect(yield* store.readData(ID)).toEqual({ settings: {}, storage: {} });
      expect(state.reads).toBe(reads + 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops the cached value when a write fails", () =>
    Effect.gen(function* () {
      const { store, state } = yield* setup;
      yield* store.writeData(ID, data("a"));
      state.failRename = true;
      yield* Effect.exit(store.writeData(ID, data("b")));
      state.failRename = false;
      expect(state.reads).toBe(0);
      expect(yield* store.readData(ID)).toEqual(data("a"));
      expect(state.reads).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
