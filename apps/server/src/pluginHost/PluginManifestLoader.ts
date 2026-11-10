// @effect-diagnostics nodeBuiltinImport:off -- The consent digest is a plain SHA-256.
import * as NodeCrypto from "node:crypto";

import {
  PLUGIN_EXTENSION_NAMESPACE,
  PLUGIN_HOST_API_VERSION,
  PLUGIN_HOST_CAPABILITIES,
  PLUGIN_MANIFEST_FIELDS,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_MAX_BYTES,
  PluginHostExtension,
  PluginStandardManifest,
  type PluginId,
} from "@t3tools/contracts";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStandard = Schema.decodeUnknownEffect(PluginStandardManifest);
const decodeExtension = Schema.decodeUnknownEffect(PluginHostExtension);

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()(
  "PluginManifestError",
  { directory: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Cannot load the plugin in ${this.directory}: ${this.reason}`;
  }
}

/** What the host reads of a plugin: the specification's name and version plus its own extension. */
export interface PluginManifest extends Omit<PluginHostExtension, "views"> {
  /** The plugin name, which is also its id. */
  readonly id: PluginId;
  readonly name: PluginId;
  readonly version: string;
  /** Only the views whose page passed the checks. */
  readonly views: PluginHostExtension["views"];
}

/** A validated plugin directory: what the host needs to run it. */
export interface PluginRegistration {
  readonly manifest: PluginManifest;
  /** Real path of the plugin directory, used as the child's working directory. */
  readonly directory: string;
  /** Real path of the entry module, inside `directory`. */
  readonly entryPath: string;
  /** Consent lasts only while this digest of name, entry, capabilities and inject is unchanged. */
  readonly digest: string;
  /** Manifest content that was reported and ignored. */
  readonly ignored: ReadonlyArray<string>;
  readonly rejectedViews: ReadonlyArray<{ readonly viewId: string; readonly reason: string }>;
}

/** Host services a plugin can ask for in `inject`, and the capability each one needs. */
const HOST_SERVICES: Readonly<Record<string, string | undefined>> = {
  log: undefined,
  handle: undefined,
  settings: "settings",
  storage: "settings",
};

const VIEW_PAGE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:\0]+\.html?$/;

/** Consent covers what decides which code runs and what it may use; titles and settings do not. */
const consentDigest = (name: string, extension: PluginHostExtension) =>
  NodeCrypto.createHash("sha256")
    .update(
      encodeJson({
        name,
        entry: extension.entry,
        capabilities: extension.capabilities.toSorted(),
        inject: extension.inject.toSorted(),
      }),
    )
    .digest("hex");

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves `relative` under `directory` after symlinks and refuses anything that escapes. */
const resolveInsideDirectory = Effect.fn("PluginManifestLoader.resolveInsideDirectory")(function* (
  directory: string,
  relative: string,
) {
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
  return { path: real, size: Number(info.size) };
});

/** The page of a view: an HTML file inside the plugin directory, small enough to serve as an MCP app. */
export const resolveViewPage = Effect.fn("PluginManifestLoader.resolveViewPage")(function* (
  directory: string,
  relative: string,
) {
  if (!VIEW_PAGE.test(relative))
    return yield* new PluginManifestError({
      directory,
      reason: `${relative} must be a relative path to an .html file inside the plugin directory.`,
    });
  const page = yield* resolveInsideDirectory(directory, relative);
  if (page.size > MCP_APP_MAX_HTML_BYTES)
    return yield* new PluginManifestError({
      directory,
      reason: `${relative} is larger than ${MCP_APP_MAX_HTML_BYTES} bytes.`,
    });
  return page.path;
});

const duplicate = (ids: ReadonlyArray<string>) =>
  ids.find((id, index) => ids.indexOf(id) !== index);

/**
 * Reads and validates `plugin.json` in `directory` as an Agent Plugins 1.0 manifest and
 * the host's extension in it. Every file the extension names must resolve, after symlinks,
 * to a file inside the directory; a view whose page does not is left out and reported.
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
  const realManifest = yield* fs
    .realPath(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is not readable.`)));
  const inside = path.relative(realDirectory, realManifest);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    return yield* fail(`${PLUGIN_MANIFEST_FILE} resolves outside the plugin directory.`);
  const raw = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => fail(`${PLUGIN_MANIFEST_FILE} is not readable.`)));
  const json = yield* parseJson(raw).pipe(
    Effect.mapError((error) => fail(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${error.message}`)),
  );
  if (!isObject(json)) return yield* fail(`${PLUGIN_MANIFEST_FILE} must be a JSON object.`);

  const ignored = Object.keys(json)
    .filter((key) => !(PLUGIN_MANIFEST_FIELDS as ReadonlyArray<string>).includes(key))
    .map((key) => `unknown top-level field "${key}"`);
  const standard = yield* decodeStandard(json).pipe(
    Effect.mapError((error) => fail(`${PLUGIN_MANIFEST_FILE} is invalid: ${error.message}`)),
  );
  if (standard.extensions !== undefined && !isObject(standard.extensions))
    ignored.push('"extensions" is not an object');
  const namespace = isObject(standard.extensions)
    ? standard.extensions[PLUGIN_EXTENSION_NAMESPACE]
    : undefined;
  if (!isObject(namespace))
    return yield* fail(
      `it has no "${PLUGIN_EXTENSION_NAMESPACE}" extension, so it contributes nothing to the T3 host.`,
    );
  const extension = yield* decodeExtension(namespace).pipe(
    Effect.mapError((error) =>
      fail(`the "${PLUGIN_EXTENSION_NAMESPACE}" extension is invalid: ${error.message}`),
    ),
  );

  if (extension.apiVersion !== PLUGIN_HOST_API_VERSION)
    return yield* fail(
      `it targets plugin API version ${extension.apiVersion}; this host implements version ${PLUGIN_HOST_API_VERSION}.`,
    );
  const supported: ReadonlyArray<string> = PLUGIN_HOST_CAPABILITIES;
  const unsupported = extension.capabilities.filter((name) => !supported.includes(name));
  if (unsupported.length > 0)
    return yield* fail(`this host does not support ${unsupported.join(", ")}.`);
  const needs = (capability: string, declared: number, what: string) =>
    declared > 0 && !extension.capabilities.includes(capability)
      ? fail(`it declares ${what} without the "${capability}" capability.`)
      : undefined;
  const missingCapability =
    needs("views", extension.views.length, "views") ??
    needs("commands", extension.commands.length, "commands") ??
    needs("settings", extension.settings.length, "settings");
  if (missingCapability) return yield* missingCapability;
  for (const [what, ids] of [
    ["view", extension.views.map((view) => view.id)],
    ["command", extension.commands.map((command) => command.id)],
    ["setting", extension.settings.map((field) => field.key)],
  ] as const) {
    const repeated = duplicate(ids);
    if (repeated !== undefined) return yield* fail(`the ${what} "${repeated}" is declared twice.`);
  }
  for (const name of extension.inject) {
    const needed = HOST_SERVICES[name];
    const available = Object.hasOwn(HOST_SERVICES, name);
    if (!available || (needed !== undefined && !extension.capabilities.includes(needed)))
      return yield* fail(`it needs the host service "${name}", which is not available to it.`);
  }

  const entry = yield* resolveInsideDirectory(realDirectory, extension.entry).pipe(
    Effect.mapError(() =>
      fail(`the entry ${extension.entry} is missing or outside the directory.`),
    ),
  );
  const views: Array<PluginHostExtension["views"][number]> = [];
  const rejectedViews: Array<{ viewId: string; reason: string }> = [];
  for (const view of extension.views) {
    const rejection = yield* resolveViewPage(realDirectory, view.html).pipe(
      Effect.match({ onSuccess: () => undefined, onFailure: (error) => error.reason }),
    );
    if (rejection === undefined) views.push(view);
    else rejectedViews.push({ viewId: view.id, reason: rejection });
  }

  return {
    manifest: {
      ...extension,
      id: standard.name,
      name: standard.name,
      version: standard.version ?? "",
      views,
    },
    directory: realDirectory,
    entryPath: entry.path,
    digest: consentDigest(standard.name, extension),
    ignored,
    rejectedViews,
  } satisfies PluginRegistration;
});
