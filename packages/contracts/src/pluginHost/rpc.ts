import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { PluginId, PluginSettingValue } from "./manifest.ts";
import { PluginHostSnapshot } from "./snapshot.ts";

export const PLUGIN_HOST_WS_METHODS = {
  pluginHostSubscribe: "pluginHost.subscribe",
  pluginHostCall: "pluginHost.call",
} as const;

const Target = { pluginId: PluginId };

/** Plugins run as trusted code, so every operation here needs the same scope as maintenance. */
export const PluginHostCallInput = Schema.Union([
  /** The environment-wide switch, off by default; while off, every other operation is refused. */
  Schema.TaggedStruct("setHostEnabled", { enabled: Schema.Boolean }),
  Schema.TaggedStruct("invoke", {
    ...Target,
    handler: Schema.String.check(Schema.isMaxLength(128)),
    input: Schema.Json,
  }),
  Schema.TaggedStruct("readView", {
    ...Target,
    viewId: TrimmedNonEmptyString,
    generation: NonNegativeInt,
  }),
  Schema.TaggedStruct("setSetting", {
    ...Target,
    key: TrimmedNonEmptyString,
    value: PluginSettingValue,
  }),
  Schema.TaggedStruct("add", { path: TrimmedNonEmptyString }),
  Schema.TaggedStruct("remove", Target),
  /** `grantConsent` records consent to the manifest as it is now. */
  Schema.TaggedStruct("enable", { ...Target, grantConsent: Schema.optionalKey(Schema.Boolean) }),
  Schema.TaggedStruct("disable", Target),
  Schema.TaggedStruct("reload", Target),
  /** Clears backoff or quarantine so the plugin starts again. */
  Schema.TaggedStruct("resume", Target),
]);
export type PluginHostCallInput = typeof PluginHostCallInput.Type;

/** `invoke` returns the handler's value, `readView` the bundle; other operations return null. */
export const PluginHostCallResult = Schema.Struct({ value: Schema.Json });
export type PluginHostCallResult = typeof PluginHostCallResult.Type;

export const PluginHostErrorReason = Schema.Literals([
  "host-disabled",
  "not-found",
  "already-registered",
  "invalid-plugin",
  "view-rejected",
  "service-conflict",
  "consent-required",
  "not-running",
  "stale-generation",
  "invalid-input",
  "call-failed",
  "io-failed",
]);
export type PluginHostErrorReason = typeof PluginHostErrorReason.Type;

export class PluginHostError extends Schema.TaggedError<PluginHostError>()("PluginHostError", {
  reason: PluginHostErrorReason,
  /** Bounded text from the manifest check or the plugin; never a raw payload. */
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `Plugin host: ${this.reason}.`
      : `Plugin host: ${this.reason}. ${this.detail}`;
  }
}

const PluginHostSubscribeRpc = Rpc.make(PLUGIN_HOST_WS_METHODS.pluginHostSubscribe, {
  payload: Schema.Struct({}),
  success: PluginHostSnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const PluginHostCallRpc = Rpc.make(PLUGIN_HOST_WS_METHODS.pluginHostCall, {
  payload: PluginHostCallInput,
  success: PluginHostCallResult,
  error: Schema.Union([PluginHostError, EnvironmentAuthorizationError]),
});

export const PluginHostRpcs = [PluginHostSubscribeRpc, PluginHostCallRpc] as const;
