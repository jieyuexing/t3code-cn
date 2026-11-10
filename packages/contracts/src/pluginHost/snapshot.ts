import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "../baseSchemas.ts";
import { PluginId, PluginSettingField, PluginSettingValue } from "./manifest.ts";

const FailureReason = Schema.String.check(Schema.isMaxLength(1000));

/**
 * `idle` plugins are not enabled; `standby` ones are enabled and offer their views
 * and commands, and start a process on the first call. Views and commands are offered
 * in `standby`, `starting` and `running`, and withdrawn in `backoff` and `quarantined`.
 */
export const PluginHostState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("standby", {}),
  Schema.TaggedStruct("starting", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("backoff", {
    failures: NonNegativeInt,
    reason: FailureReason,
    retryAt: IsoDateTime,
  }),
  Schema.TaggedStruct("quarantined", { failures: NonNegativeInt, reason: FailureReason }),
]);
export type PluginHostState = typeof PluginHostState.Type;

export const PluginHostEntry = Schema.Struct({
  id: PluginId,
  name: Schema.String,
  version: Schema.String,
  directory: Schema.String,
  enabled: Schema.Boolean,
  /** `required` until the current manifest digest has been consented to. */
  consent: Schema.Literals(["granted", "required"]),
  digest: Schema.String,
  capabilities: Schema.Array(Schema.String),
  /** Counts activations (enable, reload, resume); a mounted view of an older generation is stale. */
  generation: NonNegativeInt,
  state: PluginHostState,
  /** Operating-system process id while the plugin runs. */
  pid: Schema.optionalKey(NonNegativeInt),
  /** Why the plugin cannot be loaded or started; absent when it can. */
  problem: Schema.optionalKey(Schema.String),
  settings: Schema.Array(PluginSettingField),
  settingValues: Schema.Record(Schema.String, PluginSettingValue),
});
export type PluginHostEntry = typeof PluginHostEntry.Type;

export const PluginHostView = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  generation: NonNegativeInt,
  viewId: Schema.String,
  title: Schema.String,
  placement: Schema.String,
});
export type PluginHostView = typeof PluginHostView.Type;

export const PluginHostCommand = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  commandId: Schema.String,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export type PluginHostCommand = typeof PluginHostCommand.Type;

/**
 * Every plugin and what the active ones contribute; each frame replaces the last.
 * While the host switch is off nothing is parsed, so only the registered count is known.
 */
export const PluginHostSnapshot = Schema.Struct({
  hostEnabled: Schema.Boolean,
  registered: NonNegativeInt,
  plugins: Schema.Array(PluginHostEntry),
  views: Schema.Array(PluginHostView),
  commands: Schema.Array(PluginHostCommand),
});
export type PluginHostSnapshot = typeof PluginHostSnapshot.Type;
