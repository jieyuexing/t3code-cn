// Two fixed tools put every plugin service method an agent may call behind T3's MCP server, so the tool list
// stays the same size however many plugins there are. A method is visible only with `"agent": true` in its manifest.
import { OrchestratorMcpFailure, type PluginHostError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { assertFullAccess, loadCaller } from "../mcp/threadAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { PluginHost } from "./PluginHost.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginHost,
  ],
};

const PluginServicesTool = Tool.make("plugin_services", {
  ...shared,
  description: "List the plugin service methods you can call with plugin_call.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    services: Schema.Array(
      Schema.Struct({
        service: Schema.String,
        method: Schema.String,
        title: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        readOnly: Schema.Boolean,
        input: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
})
  .annotate(Tool.Title, "Plugin services")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PluginCallTool = Tool.make("plugin_call", {
  ...shared,
  description:
    "Call a method from plugin_services. `input` follows its input schema. A method that is not readOnly needs a full-access thread.",
  parameters: Schema.Struct({
    service: Schema.String,
    method: Schema.String,
    input: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Struct({ value: Schema.Unknown }),
})
  .annotate(Tool.Title, "Call plugin service")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const PluginToolkit = Toolkit.make(PluginServicesTool, PluginCallTool);

const isJson = Schema.is(Schema.Json);

const toFailure = (error: PluginHostError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "call-failed" || error.reason === "io-failed"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

const layerHandlers = McpToolAccess.toLayer(PluginToolkit, {
  plugin_services: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      const methods = yield* host.agentMethods;
      return {
        services: methods.map(({ service, method, title, description, readOnly, input }) => ({
          service,
          method,
          readOnly,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(input === undefined ? {} : { input }),
        })),
      };
    }),
  ),
  plugin_call: McpToolAccess.writesWithCapability((request) =>
    Effect.gen(function* () {
      const host = yield* PluginHost;
      const input = request.input ?? null;
      if (!isJson(input))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The input must be JSON.",
        });
      // A method that may change things needs what changing the environment needs.
      const known = (yield* host.agentMethods).find(
        (candidate) => candidate.service === request.service && candidate.method === request.method,
      );
      if (known !== undefined && !known.readOnly)
        yield* assertFullAccess(
          yield* loadCaller(),
          `${request.service}.${request.method} is not read-only, so it needs a full-access thread.`,
        );
      const value = yield* host
        .callAgentService({ service: request.service, method: request.method, input })
        .pipe(Effect.mapError(toFailure));
      return { value };
    }),
  ),
});

export const layerPluginAgentTools = (registration: typeof toolkitRegistration) =>
  registration(PluginToolkit, layerHandlers);
