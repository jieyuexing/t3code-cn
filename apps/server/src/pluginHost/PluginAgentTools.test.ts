import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { layerPluginAgentTools } from "./PluginAgentTools.ts";
import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";
import { CHILD } from "./testChild.ts";

const EXAMPLES = `${import.meta.dirname}/../../../../plugin-host-examples`;
const NAMESPACE = "com.jieyuexing.t3code";
const CLOCK = "example.echo-clock";
const threadId = ThreadId.make("thread-plugin-tools");

const invocation = {
  environmentId: EnvironmentId.make("environment-plugin-tools"),
  requestNamespace: "provider-session-plugin-tools",
  thread: {
    threadId,
    providerSessionId: "provider-session-plugin-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** The plugin tools over a real host whose threads run in `runtimeMode`. */
const layerFor = (runtimeMode: RuntimeMode, spawns: { count: number }) => {
  const layerHost = Layer.effect(
    PluginHost.PluginHost,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-agent-tools-" });
      return yield* PluginHost.make({
        stateDir: path.join(root, "state"),
        ...CHILD,
        attachmentsDir: path.join(root, "attachments"),
        issueUrl: (attachmentId) =>
          Effect.succeed({ relativeUrl: `/api/assets/test/${attachmentId}`, expiresAt: 1 }),
        restartBackoff: Duration.millis(1),
        stopGrace: Duration.millis(500),
        spawnProcess: (options) => {
          spawns.count += 1;
          return spawnPluginProcess(options);
        },
      });
    }),
  );
  return layerPluginAgentTools(McpHttpServer.toolkitRegistration).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { runtimeMode })),
      }),
    ),
    Layer.provideMerge(layerHost),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-agent-tools-cfg-" })),
    Layer.provideMerge(NodeServices.layer),
  );
};

const setup = Effect.fn("setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* PluginHost.PluginHost;
  const server = yield* McpServer.McpServer;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-agent-plugins-" });
  yield* host.call({ _tag: "setHostEnabled", enabled: true });
  const addExample = Effect.fn("addExample")(function* () {
    const directory = path.join(root, "echo-clock");
    yield* fs.copy(`${EXAMPLES}/echo-clock`, directory);
    yield* host.call({ _tag: "add", path: directory });
  });
  const addGenerated = Effect.fn("addGenerated")(function* (
    name: string,
    extension: Record<string, unknown>,
    source = "export function activate(context) { context.provide('agent.service', { run: () => 'ran' }); }",
  ) {
    const directory = path.join(root, name);
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(
      path.join(directory, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        extensions: { [NAMESPACE]: { apiVersion: 1, entry: "./index.mjs", ...extension } },
      }),
    );
    yield* fs.writeFileString(path.join(directory, "index.mjs"), source);
    yield* host.call({ _tag: "add", path: directory });
  });
  const enable = (id: string) =>
    host.call({ _tag: "enable", pluginId: id as never, grantConsent: true });
  const tool = (name: string, args: Record<string, unknown> = {}) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const text = (result: { readonly content: ReadonlyArray<{ readonly type: string }> }) =>
    JSON.stringify(result.content);
  return { host, addExample, addGenerated, enable, tool, text };
});

const methodsOf = (result: { readonly structuredContent?: unknown }) =>
  (
    result.structuredContent as {
      services: ReadonlyArray<{ service: string; method: string; readOnly: boolean }>;
    }
  ).services.map(({ service, method }) => `${service}.${method}`);

describe("plugin agent tools", () => {
  const spawns = { count: 0 };

  it.effect("lists and calls only the methods a plugin marks for agents", () => {
    spawns.count = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { addExample, enable, tool, text } = yield* setup();
        yield* addExample();
        yield* enable(CLOCK);

        const listed = yield* tool("plugin_services");
        expect(methodsOf(listed)).toEqual(["example.clock.now"]);
        expect(JSON.stringify(listed.structuredContent)).toContain('"properties":{"label"');

        // `info` is declared but not marked for agents: refused before any process starts.
        const hidden = yield* tool("plugin_call", { service: "example.clock", method: "info" });
        expect(hidden.isError).toBe(true);
        expect(text(hidden)).toContain("not a method agents may call");
        expect(spawns.count).toBe(0);

        const wrongShape = yield* tool("plugin_call", {
          service: "example.clock",
          method: "now",
          input: { label: 5 },
        });
        expect(wrongShape.isError).toBe(true);
        expect(text(wrongShape)).toContain("field label must be of type string");
        expect(spawns.count).toBe(0);

        const called = yield* tool("plugin_call", {
          service: "example.clock",
          method: "now",
          input: { label: "x" },
        });
        expect(called.isError).toBe(false);
        expect(JSON.stringify(called.structuredContent)).toContain("Now: ");
        expect(spawns.count).toBe(1);
      }),
    ).pipe(Effect.provide(layerFor("full-access", spawns)));
  });

  it.effect("the list and the calls follow the provider and the host switch", () => {
    spawns.count = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { host, addExample, addGenerated, enable, tool, text } = yield* setup();
        yield* addExample();
        yield* enable(CLOCK);
        const call = () =>
          tool("plugin_call", { service: "example.clock", method: "now", input: {} });
        expect((yield* call()).isError).toBe(false);

        yield* host.call({ _tag: "disable", pluginId: CLOCK as never });
        expect(methodsOf(yield* tool("plugin_services"))).toEqual([]);
        const down = yield* call();
        expect(down.isError).toBe(true);
        expect(text(down)).toContain(
          "example.echo-clock provides example.clock but is not enabled",
        );

        yield* enable(CLOCK);
        expect(methodsOf(yield* tool("plugin_services"))).toEqual(["example.clock.now"]);
        expect((yield* call()).isError).toBe(false);

        // A provider that waits for a service of its own says what it waits for.
        yield* addGenerated("agent.waiting", {
          inject: ["missing.service"],
          provides: [{ name: "agent.service", methods: [{ name: "run", agent: true }] }],
        });
        yield* enable("agent.waiting");
        const waiting = yield* tool("plugin_call", { service: "agent.service", method: "run" });
        expect(waiting.isError).toBe(true);
        expect(text(waiting)).toContain(
          "agent.waiting provides agent.service but is waiting for missing.service",
        );

        yield* host.call({ _tag: "setHostEnabled", enabled: false });
        expect(methodsOf(yield* tool("plugin_services"))).toEqual([]);
        const off = yield* call();
        expect(off.isError).toBe(true);
        expect(text(off)).toContain("host-disabled");
      }),
    ).pipe(Effect.provide(layerFor("full-access", spawns)));
  });

  const writer = {
    provides: [{ name: "agent.service", methods: [{ name: "run", agent: true, readOnly: false }] }],
  };

  it.effect("a method that is not read-only needs a full-access thread", () => {
    spawns.count = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { addGenerated, enable, tool, text } = yield* setup();
        yield* addGenerated("agent.writer", writer);
        yield* enable("agent.writer");
        const denied = yield* tool("plugin_call", { service: "agent.service", method: "run" });
        expect(denied.isError).toBe(true);
        expect(text(denied)).toContain("needs a full-access thread");
        expect(spawns.count).toBe(0);
      }),
    ).pipe(Effect.provide(layerFor("approval-required", spawns)));
  });

  it.effect("a full-access thread may call it", () => {
    spawns.count = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const { addGenerated, enable, tool } = yield* setup();
        yield* addGenerated("agent.writer", writer);
        yield* enable("agent.writer");
        const ran = yield* tool("plugin_call", { service: "agent.service", method: "run" });
        expect(ran.isError).toBe(false);
        expect(JSON.stringify(ran.structuredContent)).toContain("ran");
      }),
    ).pipe(Effect.provide(layerFor("full-access", spawns)));
  });
});
