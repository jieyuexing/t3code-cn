// Manifest shape follows pingdotgg/t3code#16053 so plugins can move between hosts.
// Fields this host does not implement (tools, actions, ...) are ignored on decode; capabilities it does not implement are refused by the loader.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

export const PLUGIN_HOST_API_VERSION = 1;
export const PLUGIN_MANIFEST_FILE = "t3-plugin.json";
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

/** Capability names this host serves; the `x.` prefix marks fork-only ones. */
export const PLUGIN_HOST_CAPABILITIES = ["settings", "views", "x.commands"] as const;

/** Owner-qualified id such as `acme.notifier`: two or more lowercase dot segments. */
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

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
  script: assetPath(/\.js$/),
  style: Schema.optionalKey(assetPath(/\.css$/)),
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
/** The plugin handler a view's call reaches, as in #16053. */
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

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
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
export type PluginManifest = typeof PluginManifest.Type;
