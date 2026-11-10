// Message tags and state names follow pingdotgg/t3code#16053; the framing is Node's own IPC channel.
// The child is trusted OS-user code, so these schemas guard against bugs, not attackers.
import { PluginId, PluginSettingValue } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type Json = Schema.Json;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
export const jsonBytes = (value: Json) => Buffer.byteLength(encodeJson(value));

const RequestId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Message = Schema.String.check(Schema.isMaxLength(2000));
const HandlerName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
);

const PluginHostMessage = Schema.Union([
  Schema.TaggedStruct("Activate", {
    pluginId: PluginId,
    version: Schema.String,
    entryPath: Schema.String,
    /** The manifest's capabilities, so the child offers only the APIs they grant. */
    capabilities: Schema.Array(Schema.String),
    /** The plugin services this plugin injects, so the child offers `context.services` for exactly those. */
    services: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("Invoke", { requestId: RequestId, handler: HandlerName, input: Schema.Json }),
  Schema.TaggedStruct("Deactivate", {}),
  Schema.TaggedStruct("HostCallSucceeded", { requestId: RequestId, value: Schema.Json }),
  Schema.TaggedStruct("HostCallFailed", { requestId: RequestId, message: Message }),
]);
export type PluginHostMessage = typeof PluginHostMessage.Type;

export const PluginLogLevel = Schema.Literals(["debug", "info", "warn", "error"]);
export type PluginLogLevel = typeof PluginLogLevel.Type;

const PluginChildMessage = Schema.Union([
  Schema.TaggedStruct("Ready", {
    handlers: Schema.Array(HandlerName),
    /** The services the plugin registered with `context.provide`, by name with their methods. */
    provided: Schema.Array(
      Schema.Struct({ name: Schema.String, methods: Schema.Array(Schema.String) }),
    ),
  }),
  Schema.TaggedStruct("ActivationFailed", { message: Message }),
  Schema.TaggedStruct("Succeeded", { requestId: RequestId, value: Schema.Json }),
  Schema.TaggedStruct("Failed", { requestId: RequestId, message: Message }),
  Schema.TaggedStruct("Log", {
    level: PluginLogLevel,
    message: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  Schema.TaggedStruct("Deactivated", {}),
  Schema.TaggedStruct("HostCall", {
    requestId: RequestId,
    method: Schema.Literals(["settings.get", "storage.get", "storage.set", "service.call"]),
    input: Schema.Json,
  }),
]);
export type PluginChildMessage = typeof PluginChildMessage.Type;

export const decodePluginChildMessage = Schema.decodeUnknownExit(PluginChildMessage);

export const HostCallInput = Schema.Struct({
  key: Schema.String,
  value: Schema.optionalKey(Schema.Json),
});

export const ServiceCallInput = Schema.Struct({
  service: Schema.String,
  method: Schema.String,
  input: Schema.Json,
});

/** The handler a service method answers under; `input` carries the call's input and its caller. */
export const serviceHandler = (service: string, method: string) => `service:${service}:${method}`;

export const PluginDataFile = Schema.Struct({
  settings: Schema.Record(Schema.String, PluginSettingValue),
  storage: Schema.Record(Schema.String, Schema.Json),
});
export type PluginDataFile = typeof PluginDataFile.Type;
