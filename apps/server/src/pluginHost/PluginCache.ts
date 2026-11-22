// Each plugin's cache: <stateDir>/plugins/cache/<pluginId>/<hash of key>.json, one file per key.
// The host may drop any of it at any time (size limit, "clear cache", removing the plugin), so a miss is
// always a normal answer. Only a light index (file size and a use order) lives in memory; after a restart it
// is rebuilt from the directory, oldest file time first.
// @effect-diagnostics nodeBuiltinImport:off -- key names are hashed and temporary files named with the platform crypto.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  cacheEvictions,
  cacheValueProblem,
  PLUGIN_CACHE_MAX_BYTES,
  PLUGIN_CACHE_MAX_VALUE_BYTES,
  type CacheUsed,
} from "@t3tools/contracts";

import type { Json } from "./PluginIpc.ts";

const Entry = Schema.Struct({ key: Schema.String, value: Schema.Json });
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(Entry));

export const makePluginCache = Effect.fn("PluginCache.make")(function* (
  stateDir: string,
  limits: { readonly maxBytes?: number; readonly maxValueBytes?: number } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = limits.maxBytes ?? PLUGIN_CACHE_MAX_BYTES;
  const maxValueBytes = limits.maxValueBytes ?? PLUGIN_CACHE_MAX_VALUE_BYTES;
  const root = path.join(stateDir, "plugins", "cache");
  const lock = yield* Semaphore.make(1);
  const indexes = new Map<string, Map<string, CacheUsed>>();
  let clock = 0;

  const directoryOf = (pluginId: string) => path.join(root, pluginId);
  const fileOf = (key: string) =>
    `${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`;

  /** The plugin's index, read from its directory the first time. Half-written files from a crash are removed. */
  const indexOf = Effect.fn("PluginCache.indexOf")(function* (pluginId: string) {
    const known = indexes.get(pluginId);
    if (known !== undefined) return known;
    const directory = directoryOf(pluginId);
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    const found: Array<{ name: string; bytes: number; modified: number }> = [];
    for (const name of names) {
      const file = path.join(directory, name);
      if (!name.endsWith(".json")) {
        yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
        continue;
      }
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isSome(info))
        found.push({
          name,
          bytes: Number(info.value.size),
          modified: Option.getOrElse(
            Option.map(info.value.mtime, (time) => time.getTime()),
            () => 0,
          ),
        });
    }
    const index = new Map<string, CacheUsed>();
    for (const { name, bytes } of found.toSorted((left, right) => left.modified - right.modified))
      index.set(name, { bytes, order: ++clock });
    indexes.set(pluginId, index);
    return index;
  });

  const total = (index: ReadonlyMap<string, CacheUsed>) =>
    [...index.values()].reduce((sum, used) => sum + used.bytes, 0);

  const get = (pluginId: string, key: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const index = yield* indexOf(pluginId);
        const name = fileOf(key);
        const used = index.get(name);
        if (used === undefined) return null as Json;
        const file = path.join(directoryOf(pluginId), name);
        const text = yield* fs.readFileString(file).pipe(Effect.option);
        const entry = Option.isSome(text) ? decodeEntry(text.value) : Option.none();
        if (Option.isNone(entry) || entry.value.key !== key) return null as Json;
        index.set(name, { ...used, order: ++clock });
        const now = yield* Clock.currentTimeMillis;
        yield* fs.utimes(file, now / 1000, now / 1000).pipe(Effect.ignore);
        return entry.value.value;
      }),
    );

  /** Fails with a sentence the plugin can show when the value is too big or cannot be written. */
  const set = (pluginId: string, key: string, value: Json) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const text = encodeEntry({ key, value });
        const bytes = new TextEncoder().encode(text).length;
        const tooLarge = cacheValueProblem(bytes, maxValueBytes);
        if (tooLarge !== undefined) return yield* Effect.fail(tooLarge);
        const index = yield* indexOf(pluginId);
        const directory = directoryOf(pluginId);
        const name = fileOf(key);
        const written = yield* Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          const temporary = path.join(directory, `${name}.${NodeCrypto.randomUUID()}.tmp`);
          yield* fs.writeFileString(temporary, text);
          yield* fs.rename(temporary, path.join(directory, name));
        }).pipe(Effect.option);
        if (Option.isNone(written)) return yield* Effect.fail("The value could not be cached.");
        index.set(name, { bytes, order: ++clock });
        // Over the total: the least recently used go first; the value just written stays.
        for (const oldest of cacheEvictions(index, name, maxBytes)) {
          yield* fs.remove(path.join(directory, oldest), { force: true }).pipe(Effect.ignore);
          index.delete(oldest);
        }
      }),
    );

  const remove = (pluginId: string, key: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const index = yield* indexOf(pluginId);
        const name = fileOf(key);
        yield* fs
          .remove(path.join(directoryOf(pluginId), name), { force: true })
          .pipe(Effect.ignore);
        index.delete(name);
      }),
    );

  /** Drops the plugin's whole cache; its storage and settings are not here and stay as they are. */
  const clear = (pluginId: string) =>
    lock.withPermits(1)(
      fs
        .remove(directoryOf(pluginId), { recursive: true, force: true })
        .pipe(Effect.ignore, Effect.andThen(Effect.sync(() => void indexes.delete(pluginId)))),
    );

  /** Bytes held per plugin, for the plugins that hold any; from the in-memory indexes after the first read of each. */
  const usage = () =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(root)
          .pipe(Effect.orElseSucceed(() => [] as string[]));
        const result: Record<string, number> = {};
        for (const pluginId of names) {
          const bytes = total(yield* indexOf(pluginId));
          if (bytes > 0) result[pluginId] = bytes;
        }
        return result;
      }),
    );

  return { get, set, delete: remove, clear, usage };
});
export type PluginCache = Effect.Success<ReturnType<typeof makePluginCache>>;
