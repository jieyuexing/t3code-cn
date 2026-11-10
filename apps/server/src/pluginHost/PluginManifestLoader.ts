// @effect-diagnostics nodeBuiltinImport:off -- The consent digest is a plain SHA-256 of the manifest bytes.
import * as NodeCrypto from "node:crypto";

import {
  PLUGIN_HOST_API_VERSION,
  PLUGIN_HOST_CAPABILITIES,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  PluginManifest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()(
  "PluginManifestError",
  { directory: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot load the plugin in ${this.directory}: ${this.reason}`;
  }
}

/** A validated plugin directory: what the host needs to run it. */
export interface PluginRegistration {
  readonly manifest: PluginManifest;
  /** Real path of the plugin directory, used as the child's working directory. */
  readonly directory: string;
  /** Real path of the entry module, inside `directory`. */
  readonly entryPath: string;
  /** SHA-256 of the manifest bytes; consent lasts only while it is unchanged. */
  readonly digest: string;
}

/** Host services a plugin can ask for in `inject`, and the capability each one needs. */
const HOST_SERVICES: Readonly<Record<string, string | undefined>> = {
  log: undefined,
  handle: undefined,
  settings: "settings",
  storage: "settings",
};

/** Resolves `relative` under `directory` after symlinks and refuses anything that escapes. */
export const resolveInsideDirectory = Effect.fn("PluginManifestLoader.resolveInsideDirectory")(
  function* (directory: string, relative: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fail = (reason: string) => new PluginManifestError({ directory, reason });
    const real = yield* fs
      .realPath(path.resolve(directory, relative))
      .pipe(Effect.mapError(() => fail(`${relative} does not exist.`)));
    const inside = path.relative(directory, real);
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      return yield* fail(`${relative} resolves outside the plugin directory.`);
    const info = yield* fs
      .stat(real)
      .pipe(Effect.mapError(() => fail(`${relative} is not readable.`)));
    if (info.type !== "File") return yield* fail(`${relative} is not a file.`);
    return real;
  },
);

const duplicate = (ids: ReadonlyArray<string>) =>
  ids.find((id, index) => ids.indexOf(id) !== index);

/**
 * Reads and validates `t3-plugin.json` in `directory`. Every file the manifest
 * names must resolve, after symlinks, to a file inside the directory.
 */
export const loadPluginDirectory = Effect.fn("PluginManifestLoader.loadPluginDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (reason: string) => new PluginManifestError({ directory, reason });

  const realDirectory = yield* fs
    .realPath(directory)
    .pipe(Effect.mapError(() => fail("the directory does not exist.")));
  const manifestPath = path.join(realDirectory, PLUGIN_MANIFEST_FILE);
  const info = yield* fs
    .stat(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is missing.`)));
  if (info.type !== "File" || Number(info.size) > PLUGIN_MANIFEST_MAX_BYTES)
    return yield* fail(`${PLUGIN_MANIFEST_FILE} must be a file of at most 64 KiB.`);
  const raw = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is not readable.`)));
  const manifest = yield* decodeManifest(raw).pipe(
    Effect.mapError((error) => fail(`${PLUGIN_MANIFEST_FILE} is invalid: ${error.message}`)),
  );

  if (manifest.apiVersion !== PLUGIN_HOST_API_VERSION)
    return yield* fail(
      `it targets plugin API version ${manifest.apiVersion}; this host implements version ${PLUGIN_HOST_API_VERSION}.`,
    );
  const supported: ReadonlyArray<string> = PLUGIN_HOST_CAPABILITIES;
  const unsupported = manifest.capabilities.filter((name) => !supported.includes(name));
  if (unsupported.length > 0)
    return yield* fail(`this host does not support ${unsupported.join(", ")}.`);
  const needs = (capability: string, declared: number, what: string) =>
    declared > 0 && !manifest.capabilities.includes(capability)
      ? fail(`it declares ${what} without the "${capability}" capability.`)
      : undefined;
  const missingCapability =
    needs("views", manifest.views.length, "views") ??
    needs("x.commands", manifest.commands.length, "commands") ??
    needs("settings", manifest.settings.length, "settings");
  if (missingCapability) return yield* missingCapability;
  for (const [what, ids] of [
    ["view", manifest.views.map((view) => view.id)],
    ["command", manifest.commands.map((command) => command.id)],
    ["setting", manifest.settings.map((field) => field.key)],
  ] as const) {
    const repeated = duplicate(ids);
    if (repeated !== undefined) return yield* fail(`the ${what} "${repeated}" is declared twice.`);
  }
  for (const name of manifest.inject) {
    const needed = HOST_SERVICES[name];
    const available = Object.hasOwn(HOST_SERVICES, name);
    if (!available || (needed !== undefined && !manifest.capabilities.includes(needed)))
      return yield* fail(`it needs the host service "${name}", which is not available to it.`);
  }

  const resolve = (relative: string, what: string) =>
    resolveInsideDirectory(realDirectory, relative).pipe(
      Effect.mapError(() => fail(`the ${what} ${relative} is missing or outside the directory.`)),
    );
  const entryPath = yield* resolve(manifest.entry, "entry");
  for (const view of manifest.views) {
    yield* resolve(view.script, `script of view ${view.id}`);
    if (view.style !== undefined) yield* resolve(view.style, `style of view ${view.id}`);
  }

  const digest = NodeCrypto.createHash("sha256").update(raw).digest("hex");
  return { manifest, directory: realDirectory, entryPath, digest } satisfies PluginRegistration;
});
