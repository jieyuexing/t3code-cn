// Files live under <stateDir>/plugins and are created on first write, so a server without plugins touches nothing.
import { PluginId, RailConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { PluginDataFile } from "./PluginIpc.ts";

const RegistryRecord = Schema.Struct({
  id: PluginId,
  path: Schema.String,
  enabled: Schema.Boolean,
});
export type RegistryRecord = typeof RegistryRecord.Type;

const isRegistryRecord = Schema.is(RegistryRecord);
const isRegistryFile = Schema.is(
  Schema.Struct({
    enabled: Schema.optionalKey(Schema.Boolean),
    plugins: Schema.Array(Schema.Unknown),
  }),
);
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.String));
const decodeData = Schema.decodeUnknownOption(PluginDataFile);
const decodeRail = Schema.decodeUnknownEffect(RailConfig);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class PluginStoreError extends Schema.TaggedError<PluginStoreError>()("PluginStoreError", {
  file: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Cannot read or write ${this.file}.`;
  }
}

const emptyData: PluginDataFile = { settings: {}, storage: {} };

export const makePluginStore = Effect.fn("PluginStore.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "plugins");
  const registryPath = path.join(directory, "registry.json");
  const consentPath = path.join(directory, "consent.json");
  const railPath = path.join(directory, "rail.json");
  const dataPath = (id: string) => path.join(directory, "data", `${id}.json`);

  /** A missing file is empty; an unreadable one is an error so a write never replaces it. */
  const readJson = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | undefined => text),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(error),
      }),
      Effect.flatMap((text) => (text === undefined ? Effect.undefined : parseJson(text))),
      Effect.mapError((cause) => new PluginStoreError({ file: path.basename(file), cause })),
    );

  const writeJson = Effect.fn("PluginStore.writeJson")(
    function* (file: string, value: unknown) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      yield* fs.writeFileString(temporary, `${encodeJson(value)}\n`);
      yield* fs.rename(temporary, file);
    },
    (effect, file) =>
      effect.pipe(
        Effect.mapError((cause) => new PluginStoreError({ file: path.basename(file), cause })),
      ),
  );

  const readRegistry = readJson(registryPath).pipe(
    Effect.map((value) =>
      isRegistryFile(value)
        ? { enabled: value.enabled === true, plugins: value.plugins.filter(isRegistryRecord) }
        : { enabled: false, plugins: [] },
    ),
  );

  const readConsent = readJson(consentPath).pipe(
    Effect.map((value) => (isJsonObject(value) ? value : ({} as Record<string, string>))),
  );

  /** Missing is `undefined`; a file that does not parse or fit the schema is an error so a write never replaces it. */
  const readRail = readJson(railPath).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.undefined
        : decodeRail(value).pipe(
            Effect.mapError((cause) => new PluginStoreError({ file: "rail.json", cause })),
          ),
    ),
  );

  /**
   * Plugin data files are re-read and re-validated whole, and a view fires dozens of reads at once, so the last
   * result per plugin is kept. A cached value is valid only while the file's stat still matches, so a file
   * deleted or edited outside the store is seen on the next read. The cached object is shared; callers copy it.
   */
  const dataCache = new Map<string, { readonly stamp: string; readonly value: PluginDataFile }>();

  /** Undefined when the file is missing or unreadable, or the platform gives no mtime: nothing is cached then. */
  const statStamp = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) =>
        Option.isSome(info.mtime)
          ? `${info.mtime.value.getTime()}:${info.size}:${Option.getOrElse(info.ino, () => 0)}`
          : undefined,
      ),
      Effect.orElseSucceed((): string | undefined => undefined),
    );

  const readData = Effect.fn("PluginStore.readData")(function* (id: string) {
    const file = dataPath(id);
    // The stat comes first: a write racing the read can then only leave an older stamp, which misses next time.
    const stamp = yield* statStamp(file);
    const cached = dataCache.get(id);
    if (stamp !== undefined && cached?.stamp === stamp) return cached.value;
    dataCache.delete(id);
    const value = yield* readJson(file);
    const decoded = value === undefined ? undefined : decodeData(value);
    if (decoded?._tag !== "Some") return emptyData;
    if (stamp !== undefined) dataCache.set(id, { stamp, value: decoded.value });
    return decoded.value;
  });

  const writeData = Effect.fn("PluginStore.writeData")(function* (
    id: string,
    data: PluginDataFile,
  ) {
    // Dropped first so a failed or interrupted write never leaves the old value behind.
    dataCache.delete(id);
    const file = dataPath(id);
    yield* writeJson(file, data);
    const stamp = yield* statStamp(file);
    if (stamp !== undefined) dataCache.set(id, { stamp, value: data });
  });

  return {
    readRegistry,
    writeRegistry: (registry: {
      readonly enabled: boolean;
      readonly plugins: ReadonlyArray<RegistryRecord>;
    }) => writeJson(registryPath, registry),
    readRail,
    writeRail: (rail: RailConfig) => writeJson(railPath, rail),
    readConsent,
    writeConsent: (consent: Readonly<Record<string, string>>) => writeJson(consentPath, consent),
    readData,
    writeData,
  };
});
export type PluginStore = Effect.Success<ReturnType<typeof makePluginStore>>;
