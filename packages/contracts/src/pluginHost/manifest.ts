// Agent Plugins 1.0 (https://agent-plugins.org/specification): a root `plugin.json` whose host-specific part
// lives under `extensions[PLUGIN_EXTENSION_NAMESPACE]`. This host reads nothing else from the manifest.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

export const PLUGIN_HOST_API_VERSION = 1;
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
const PLUGIN_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const PLUGIN_EXTENSION_NAMESPACE = "com.jieyuexing.t3code";

/** Capability names this host serves; the `x.` prefix marks fork-only ones. */
export const PLUGIN_HOST_CAPABILITIES = ["settings", "views", "commands"] as const;

/** The only top-level fields the specification permits in `plugin.json`. */
export const PLUGIN_MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
] as const;

/** The specification's plugin name: 1-64 of a-z, 0-9, `-` and `.`, alphanumeric at both ends, no `--` or `..`. */
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  Schema.makeFilter((name) => !/--|\.\./.test(name) || "A plugin name has no `--` or `..`."),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

const PluginAuthor = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(
    (author) =>
      Object.keys(author).every((key) => ["name", "email", "url"].includes(key)) ||
      "An author has only name, email and url.",
  ),
);

/** The portable part of `plugin.json`; unknown top-level fields are reported by the loader, not rejected. */
export const PluginStandardManifest = Schema.Struct({
  $schema: Schema.Literal(PLUGIN_SCHEMA_ID),
  name: PluginId,
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(PluginAuthor),
  homepage: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  license: Schema.optionalKey(Schema.String),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  extensions: Schema.optionalKey(Schema.Unknown),
});

const PluginCapabilityName = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/),
);

/** Relative path inside the plugin directory, without `..` segments. */
const assetPath = (extension: RegExp) =>
  Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:\0]+$/),
    Schema.isPattern(extension),
  );

const PluginViewDeclaration = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  placement: Schema.Literal("side-panel"),
  /** A whole HTML page inside the plugin directory; the loader checks it per view, so one bad page rejects only that view. */
  html: Schema.String.check(Schema.isMaxLength(256)),
});
export type PluginViewDeclaration = typeof PluginViewDeclaration.Type;

const PluginCommandDeclaration = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
});
export type PluginCommandDeclaration = typeof PluginCommandDeclaration.Type;

/** The plugin handler a command runs; plugins register it with `context.handle`. */
export const pluginCommandHandler = (commandId: string) => `command:${commandId}`;
/** The plugin handler a view's call reaches. */
export const pluginViewHandler = (viewId: string, handler: string) => `view:${viewId}:${handler}`;

const settingBase = {
  key: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
};

/** Text, boolean and number fields; `select` and `secret` are not served yet. */
export const PluginSettingField = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    ...settingBase,
    default: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  }),
  Schema.Struct({
    type: Schema.Literal("boolean"),
    ...settingBase,
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("number"),
    ...settingBase,
    default: Schema.optionalKey(Schema.Finite),
  }),
]);
export type PluginSettingField = typeof PluginSettingField.Type;

export const PluginSettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type PluginSettingValue = typeof PluginSettingValue.Type;

/** The contents of `extensions[PLUGIN_EXTENSION_NAMESPACE]`; other keys are ignored. */
export const PluginHostExtension = Schema.Struct({
  apiVersion: Schema.Int,
  entry: assetPath(/\.m?js$/),
  capabilities: Schema.Array(PluginCapabilityName)
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Host services the plugin needs; the plugin does not start when one is unavailable. */
  inject: Schema.Array(Schema.String.check(Schema.isMaxLength(64)))
    .check(Schema.isMaxLength(16))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  views: Schema.Array(PluginViewDeclaration)
    .check(Schema.isMaxLength(8))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  commands: Schema.Array(PluginCommandDeclaration)
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  settings: Schema.Array(PluginSettingField)
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PluginHostExtension = typeof PluginHostExtension.Type;
