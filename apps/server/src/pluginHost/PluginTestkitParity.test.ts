import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PluginHostCallInput } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { createPluginContext } from "../../../web/src/pluginHost/testkit/index.ts";
import * as PluginHost from "./PluginHost.ts";
import { spawnPluginProcess } from "./PluginProcess.ts";
import { CHILD } from "./testChild.ts";

const NAMESPACE = "com.jieyuexing.t3code";
const SERVICE = "parity.svc";
const PROVIDER = "parity.provider";
const CONSUMER = "parity.consumer";

/** One plugin source, run by the real host in a child process and by the testkit in this one. */
const CONSUMER_SOURCE = `
export function activate(context) {
  context.handle("storageSet", ({ key, size }) => context.storage.set(key, "x".repeat(size)));
  context.handle("storageGet", ({ key }) => context.storage.get(key));
  context.handle("cacheSet", ({ key, size }) => context.cache.set(key, "x".repeat(size)));
  context.handle("setting", ({ key }) => context.settings.get(key));
  context.handle("service", ({ service, method }) => context.services[service][method]({}));
  context.handle("noKey", () => context.storage.get(undefined));
}
`;
const PROVIDER_SOURCE = `
export function activate(context) {
  context.provide(${JSON.stringify(SERVICE)}, {
    peek: () => "peeked",
    write: () => "written",
    boom: () => { throw Object.assign(new Error("boom"), { code: "missingClient" }); },
  });
}
`;
const METHODS = [{ name: "peek", readOnly: true }, { name: "write" }, { name: "boom" }];

const setup = Effect.fn("setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-parity-" });
  const host = yield* PluginHost.make({
    stateDir: path.join(root, "state"),
    ...CHILD,
    attachmentsDir: path.join(root, "attachments"),
    issueUrl: (attachmentId) =>
      Effect.succeed({ relativeUrl: `/api/assets/test/${attachmentId}`, expiresAt: 1 }),
    maxFailures: 3,
    restartBackoff: Duration.millis(1),
    maxRestartBackoff: Duration.millis(1),
    stopGrace: Duration.millis(500),
    spawnProcess: spawnPluginProcess,
  });
  yield* host.call({ _tag: "setHostEnabled", enabled: true });
  const call = (input: PluginHostCallInput) => host.call(input);
  const add = Effect.fn("add")(function* (name: string, extension: object, source: string) {
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
    yield* call({ _tag: "add", path: directory });
    yield* call({ _tag: "enable", pluginId: name as never, grantConsent: true });
  });
  yield* add(PROVIDER, { provides: [{ name: SERVICE, methods: METHODS }] }, PROVIDER_SOURCE);
  yield* add(
    CONSUMER,
    {
      capabilities: ["settings"],
      inject: [SERVICE],
      settings: [{ key: "name", type: "text", label: "Name" }],
    },
    CONSUMER_SOURCE,
  );
  /** The provider's data revision as the host's snapshot reports it now. */
  const revision = host.subscribe.pipe(
    Stream.runHead,
    Effect.map((head) =>
      head._tag === "Some"
        ? (head.value.plugins.find((plugin) => plugin.id === PROVIDER)?.dataRevision ?? 0)
        : 0,
    ),
  );
  return { call, revision };
});

/** The consumer's handlers as the testkit runs them, with a provider that answers like the real one. */
const testkit = () => {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const pluginContext = createPluginContext({
    pluginId: CONSUMER,
    capabilities: ["settings"],
    settings: { name: "n" },
    inject: [SERVICE],
    providers: {
      [SERVICE]: {
        plugin: PROVIDER,
        methods: {
          peek: { readOnly: true, run: () => "peeked" },
          write: { run: () => "written" },
          boom: {
            run: () => {
              throw Object.assign(new Error("boom"), { code: "missingClient" });
            },
          },
        },
      },
    },
  });
  const activate = new Function(
    `${CONSUMER_SOURCE.replace("export ", "")}; return activate;`,
  )() as (context: object) => void;
  activate({
    ...pluginContext.context,
    handle: (name: string, fn: () => unknown) => handlers.set(name, fn),
  });
  return {
    pluginContext,
    failure: async (handler: string, input: unknown) => {
      try {
        await handlers.get(handler)!(input);
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    },
  };
};

const CACHE_VALUE_LIMIT = 2 * 1024 * 1024;
const CACHE_ENTRY_OVERHEAD = `{"key":"k","value":""}`.length;

const CASES: ReadonlyArray<readonly [string, string, unknown]> = [
  ["storageSet", "at the storage limit", { key: "k", size: 256 * 1024 - 2 }],
  ["storageSet", "over the storage limit", { key: "k", size: 256 * 1024 - 1 }],
  [
    "cacheSet",
    "at the cache value limit",
    { key: "k", size: CACHE_VALUE_LIMIT - CACHE_ENTRY_OVERHEAD },
  ],
  [
    "cacheSet",
    "over the cache value limit",
    { key: "k", size: CACHE_VALUE_LIMIT - CACHE_ENTRY_OVERHEAD + 1 },
  ],
  ["setting", "an undeclared setting", { key: "other" }],
  ["noKey", "a request without a key", null],
  ["service", "a method the service does not declare", { service: SERVICE, method: "nothing" }],
  ["service", "a method that throws", { service: SERVICE, method: "boom" }],
  ["service", "a method that works", { service: SERVICE, method: "write" }],
];

describe("the plugin testkit against the real host", () => {
  it.live("answers each plugin-side call with the host's own sentence or success", () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      const kit = testkit();
      const outcomes: Array<[string, string | undefined, string | undefined]> = [];
      for (const [handler, label, input] of CASES) {
        const host = yield* call({
          _tag: "invoke",
          pluginId: CONSUMER as never,
          handler,
          input: input as never,
        }).pipe(
          Effect.as(undefined),
          Effect.catchTags({ PluginHostError: (error) => Effect.succeed(error.detail) }),
        );
        const local = yield* Effect.promise(() => kit.failure(handler, input));
        outcomes.push([label, host, local === undefined ? undefined : `failed: ${local}`]);
      }
      expect(outcomes.map(([label, host, local]) => [label, host === local])).toEqual(
        CASES.map(([, label]) => [label, true]),
      );
      // The cases only mean something if the limits and the refusals are really what the host said.
      const sentences = outcomes.map(([, host]) => host);
      expect(sentences).toEqual([
        undefined,
        "failed: The value is too large to store.",
        undefined,
        "failed: The value is too large to cache.",
        "failed: Unknown setting other.",
        "failed: The request needs a key.",
        "failed: The service parity.svc has no method nothing.",
        "failed: parity.svc (parity.provider): failed: boom",
        undefined,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("moves the provider's data revision only after a method that is not read-only", () =>
    Effect.gen(function* () {
      const { call, revision } = yield* setup();
      const kit = testkit();
      const invoke = (method: string) =>
        call({
          _tag: "invoke",
          pluginId: CONSUMER as never,
          handler: "service",
          input: { service: SERVICE, method } as never,
        }).pipe(Effect.ignore);
      const local = (method: string) =>
        Effect.promise(() => kit.failure("service", { service: SERVICE, method }));
      const revisions: Array<readonly [number, number]> = [];
      for (const method of ["peek", "boom", "write"]) {
        yield* invoke(method);
        yield* local(method);
        revisions.push([yield* revision, kit.pluginContext.dataRevision(PROVIDER)]);
      }
      expect(revisions).toEqual([
        [0, 0],
        [0, 0],
        [1, 1],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
