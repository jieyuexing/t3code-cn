// Files live under <stateDir>/plugins and are created on first write, so a server without plugins touches nothing.
import { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

  const readData = (id: string) =>
    readJson(dataPath(id)).pipe(
      Effect.map((value) => {
        const decoded = value === undefined ? undefined : decodeData(value);
        return decoded?._tag === "Some" ? decoded.value : emptyData;
      }),
    );

  return {
    readRegistry,
    writeRegistry: (registry: {
      readonly enabled: boolean;
      readonly plugins: ReadonlyArray<RegistryRecord>;
    }) => writeJson(registryPath, registry),
    readConsent,
    writeConsent: (consent: Readonly<Record<string, string>>) => writeJson(consentPath, consent),
    readData,
    writeData: (id: string, data: PluginDataFile) => writeJson(dataPath(id), data),
  };
});
export type PluginStore = Effect.Success<ReturnType<typeof makePluginStore>>;
