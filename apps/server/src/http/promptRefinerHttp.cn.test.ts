import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  TextGenerationError,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { HttpBody, HttpRouter, HttpServer } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  PROMPT_ADVISOR_PREFIX,
  type PromptAdvisorOutputReading,
  type PromptAdvisorRuntime,
} from "../textGeneration/promptAdvisor.cn.ts";
import {
  DEFAULT_PROMPT_ADVISOR_CONFIG,
  type PromptAdvisorConfig,
  targetSignature,
} from "../textGeneration/promptAdvisorConfig.cn.ts";
import { stubPromptAdvisorRuntime } from "../textGeneration/promptAdvisor.testkit.cn.ts";
import { registerPromptAdvisor } from "../textGeneration/promptAdvisorRegistry.cn.ts";
import {
  PROMPT_ADVISOR_CONFIG_FILE,
  PROMPT_ADVISOR_TEST_RUN_PATH,
  PROMPT_ADVISOR_CONFIG_PATH,
  PROMPT_REFINE_PATH,
  promptRefinerRouteLayer,
} from "./promptRefinerHttp.cn.ts";

const SESSION = {
  sessionId: AuthSessionId.make("refiner-test"),
  subject: "refiner-test",
  method: "bearer-access-token" as const,
};

const advisor = (
  runPrompt: PromptAdvisorRuntime["runPrompt"],
  prompts: Array<string> = [],
): PromptAdvisorRuntime =>
  stubPromptAdvisorRuntime({
    runPrompt: (prompt) => {
      prompts.push(prompt);
      return runPrompt(prompt);
    },
  });

const reply = (refined: string) => () => Effect.succeed(JSON.stringify({ refined }));

/** Serves the route with a workspace at `root` for project `p1` and for thread `t1`'s worktree. */
const serve = (options: {
  readonly root: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly authFails?: boolean;
  /** Written to the state directory before the routes start, as if saved by an earlier run. */
  readonly savedConfig?: string;
}) =>
  Effect.gen(function* () {
    const serverConfig = yield* Layer.build(
      ServerConfig.layerTest(options.root, { prefix: "t3-refiner-state-" }),
    );
    const { stateDir } = Context.get(serverConfig, ServerConfig.ServerConfig);
    const configFile = `${stateDir}/${PROMPT_ADVISOR_CONFIG_FILE}`;
    if (options.savedConfig !== undefined) {
      yield* (yield* FileSystem.FileSystem).writeFileString(configFile, options.savedConfig);
    }
    const services = yield* Layer.build(
      HttpRouter.serve(promptRefinerRouteLayer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(Layer.succeedContext(serverConfig)),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              options.authFails === true
                ? Effect.fail(
                    new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "no" }),
                  )
                : Effect.succeed({
                    ...SESSION,
                    scopes: options.scopes ?? [AuthOrchestrationOperateScope],
                  }),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService, {
            getById: (projectId) =>
              Effect.succeed(
                projectId === "p1"
                  ? Option.some({ workspaceRoot: options.root } as never)
                  : Option.none(),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService, {
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === "t1" ? ({ projectId: "p1", worktreePath: null } as never) : null,
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2, {
            getTimelinePage: () =>
              Effect.succeed({
                items: [{ item: { type: "user_message", text: "先看下 server.ts" } }],
                totalItems: 1,
                hasMore: false,
                hasEarlier: false,
              } as never),
          }),
        ),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address);
    const request = (
      method: "GET" | "PUT" | "POST",
      path: string,
      body?: unknown,
      init?: { readonly raw?: boolean },
    ) =>
      HttpClient.execute(
        HttpClientRequest.make(method)(`http://${origin.replace(/^http:\/\//, "")}${path}`).pipe(
          body === undefined
            ? (self) => self
            : HttpClientRequest.setBody(
                HttpBody.text(
                  init?.raw === true ? String(body) : JSON.stringify(body),
                  "application/json",
                ),
              ),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.json, (json) => ({
            status: response.status,
            json: json as Record<string, unknown>,
          })),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.orDie,
      );
    return Object.assign(
      (body: unknown, init?: { readonly raw?: boolean }) =>
        request("POST", PROMPT_REFINE_PATH, body, init),
      {
        request,
        configFile,
      },
    );
  });

const withWorkspace = <A, E>(
  body: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-refiner-http-" }),
    );
    yield* fs.writeFileString(`${root}/AGENTS.md`, "仓库规则：先读再改");
    return yield* body(root);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("refuses unauthenticated and under-scoped callers", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const unauthenticated = yield* (yield* serve({ root, authFails: true }))({ draft: "x" });
      expect(unauthenticated.status).toBe(401);
      const readOnly = yield* (yield* serve({ root, scopes: [AuthOrchestrationReadScope] }))({
        draft: "x",
      });
      expect(readOnly.status).toBe(403);
    }),
  ),
);

it.live("rejects malformed requests with 400", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor("test", advisor(reply("x")));
      const post = yield* serve({ root });
      for (const body of [
        { draft: "   " },
        { draft: "a".repeat(20_001) },
        { draft: "abc", mode: "wild" },
        { draft: "abc", selection: { start: 2, end: 1 } },
        { draft: "abc", selection: { start: 0, end: 9 } },
        { draft: "abc", selection: { start: 0.5, end: 1 } },
        { nothing: true },
      ]) {
        const result = yield* post(body);
        expect(result.status, JSON.stringify(body)).toBe(400);
        expect(typeof result.json.error).toBe("string");
      }
      expect((yield* post("{not json", { raw: true })).status).toBe(400);
    }),
  ),
);

it.live("answers 503 while no advisor is available", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const result = yield* (yield* serve({ root }))({ draft: "看一下架构" });
      expect(result.status).toBe(503);
    }),
  ),
);

it.live("refines with the project's workspace context, defaulting to structured", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      yield* registerPromptAdvisor("test", advisor(reply("更清晰的版本"), prompts));
      const result = yield* (yield* serve({ root }))({ draft: "看一下架构", projectId: "p1" });
      expect(result).toEqual({
        status: 200,
        json: { refined: "更清晰的版本", mode: "structured", usedWorkspaceContext: true },
      });
      expect(prompts[0]).toContain("仓库规则：先读再改");
      expect(prompts[0]).toContain("Mode structured");
    }),
  ),
);

it.live("adds the thread tail and workspace for a thread id and honours mode and selection", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      yield* registerPromptAdvisor("test", advisor(reply("替换段"), prompts));
      const result = yield* (yield* serve({ root }))({
        draft: "前文看架构后文",
        selection: { start: 2, end: 5 },
        mode: "bold",
        threadId: "t1",
      });
      expect(result.json).toEqual({ refined: "替换段", mode: "bold", usedWorkspaceContext: true });
      expect(prompts[0]).toContain("先看下 server.ts");
      expect(prompts[0]).toContain("仓库规则：先读再改");
      expect(prompts[0]).toContain("<composer_selection>\n看架构\n</composer_selection>");
    }),
  ),
);

it.live("reports no workspace context for a draft without project or thread", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor("test", advisor(reply("好")));
      const result = yield* (yield* serve({ root }))({ draft: "你好", projectId: null });
      expect(result.json.usedWorkspaceContext).toBe(false);
    }),
  ),
);

it.live("answers 502 when sampling fails", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor(
        "test",
        advisor(() =>
          Effect.fail(
            new TextGenerationError({
              operation: "samplePromptAdvisor",
              detail: "Antigravity advisor timed out.",
            }),
          ),
        ),
      );
      const failed = yield* (yield* serve({ root }))({ draft: "你好" });
      expect(failed.status).toBe(502);
      expect(failed.json.error).toBe("Antigravity advisor timed out.");
    }),
  ),
);

const CUSTOM_CONFIG: PromptAdvisorConfig = {
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  advisor: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
    runtime: { instanceId: null, model: "gemini-4-hydrogen", thinking: "minimal" },
    lenses: { grilling: false, debugging: true, blastRadius: false },
    customAppendix: "多关注回归风险。",
  },
  refiner: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
    modeOverrides: { structured: "只把草稿改成三句话。", bold: "", scoped: "" },
  },
};

it.live("keeps the config routes behind the same authentication as refining", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const denied = yield* serve({ root, authFails: true });
      expect((yield* denied.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).status).toBe(401);
      expect(
        (yield* denied.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG }))
          .status,
      ).toBe(401);
      const readOnly = yield* serve({ root, scopes: [AuthOrchestrationReadScope] });
      expect((yield* readOnly.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).status).toBe(403);
      expect(
        (yield* readOnly.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG }))
          .status,
      ).toBe(403);
      expect(yield* (yield* FileSystem.FileSystem).exists(readOnly.configFile)).toBe(false);
    }),
  ),
);

it.live("serves the defaults with every role unavailable while no instance is registered", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const result = yield* (yield* serve({ root })).request("GET", PROMPT_ADVISOR_CONFIG_PATH);
      expect(result.status).toBe(200);
      const body = result.json as unknown as {
        config: PromptAdvisorConfig;
        defaults: PromptAdvisorConfig;
        status: {
          instances: Array<unknown>;
          advisor: { state: string };
          refiner: { state: string };
        };
        previews: { advisorPromptPreview: string; refinerModePreviews: Record<string, string> };
      };
      expect(body.config).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
      expect(body.defaults).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
      expect(body.status.instances).toEqual([]);
      expect(body.status.advisor.state).toBe("unavailable");
      expect(body.status.refiner.state).toBe("unavailable");
      expect(body.previews.advisorPromptPreview).toContain("BEGIN CONVERSATION TRANSCRIPT");
      expect(Object.keys(body.previews.refinerModePreviews)).toEqual([
        "structured",
        "bold",
        "scoped",
      ]);
    }),
  ),
);

it.live("saves a valid config, reports it back and applies it to the next refinement", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      yield* registerPromptAdvisor("test", advisor(reply("改好了"), prompts));
      const api = yield* serve({ root });
      const saved = yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
        config: CUSTOM_CONFIG,
      });
      expect(saved.status).toBe(200);
      expect(saved.json.config).toEqual(CUSTOM_CONFIG);
      const fs = yield* FileSystem.FileSystem;
      expect(JSON.parse(yield* fs.readFileString(api.configFile))).toEqual(CUSTOM_CONFIG);
      expect(yield* fs.exists(`${api.configFile}.tmp`)).toBe(false);
      const body = (yield* api.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).json as unknown as {
        config: PromptAdvisorConfig;
        status: { advisor: { state: string; resolvedInstanceId: string } };
        previews: { advisorPromptPreview: string; refinerModePreviews: Record<string, string> };
      };
      expect(body.config).toEqual(CUSTOM_CONFIG);
      expect(body.status.advisor).toMatchObject({ state: "idle", resolvedInstanceId: "test" });
      expect(body.previews.advisorPromptPreview).toContain("多关注回归风险。");
      expect(body.previews.refinerModePreviews.structured).toContain("只把草稿改成三句话。");
      expect((yield* api({ draft: "看一下架构" })).status).toBe(200);
      expect(prompts[0]).toContain("只把草稿改成三句话。");
      expect(prompts[0]).not.toContain("Mode structured");
    }),
  ),
);

it.live("rejects an invalid config with 400 and leaves the saved one alone", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const api = yield* serve({ root });
      yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG });
      const fs = yield* FileSystem.FileSystem;
      const before = yield* fs.readFileString(api.configFile);
      const withRuntime = (runtime: unknown) => ({
        ...CUSTOM_CONFIG,
        advisor: { ...CUSTOM_CONFIG.advisor, runtime },
      });
      for (const body of [
        {},
        { config: null },
        { config: { ...CUSTOM_CONFIG, version: 2 } },
        { config: withRuntime({ instanceId: "", model: null, thinking: null }) },
        { config: withRuntime({ instanceId: null, model: 7, thinking: null }) },
        {
          config: {
            ...CUSTOM_CONFIG,
            advisor: { ...CUSTOM_CONFIG.advisor, lenses: { grilling: true } },
          },
        },
        {
          config: {
            ...CUSTOM_CONFIG,
            advisor: { ...CUSTOM_CONFIG.advisor, promptOverride: "长".repeat(8_001) },
          },
        },
        {
          config: {
            ...CUSTOM_CONFIG,
            advisor: { ...CUSTOM_CONFIG.advisor, customAppendix: "长".repeat(2_001) },
          },
        },
      ]) {
        const result = yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, body);
        expect(result.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      }
      expect(
        (yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, "{nope", { raw: true })).status,
      ).toBe(400);
      expect(yield* fs.readFileString(api.configFile)).toBe(before);
      expect(
        (
          (yield* api.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).json as unknown as {
            config: PromptAdvisorConfig;
          }
        ).config,
      ).toEqual(CUSTOM_CONFIG);
    }),
  ),
);

it.live(
  "loads the saved config when the routes start and falls back to the default on damage",
  () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const saved = yield* serve({ root, savedConfig: JSON.stringify(CUSTOM_CONFIG) });
        expect(
          (
            (yield* saved.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).json as unknown as {
              config: PromptAdvisorConfig;
            }
          ).config,
        ).toEqual(CUSTOM_CONFIG);
        const damaged = yield* serve({ root, savedConfig: "{ half a file" });
        expect(
          (
            (yield* damaged.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).json as unknown as {
              config: PromptAdvisorConfig;
            }
          ).config,
        ).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
        expect(yield* (yield* FileSystem.FileSystem).readFileString(damaged.configFile)).toBe(
          "{ half a file",
        );
      }),
    ),
);

const TEST_RUN_PATH = PROMPT_ADVISOR_TEST_RUN_PATH;
const encodedItems = (...items: ReadonlyArray<{ kind: string; label: string; fill: string }>) =>
  `${PROMPT_ADVISOR_PREFIX}${JSON.stringify({ items })}`;

it.live("keeps the test run behind the same authentication and validates its body", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const denied = yield* serve({ root, authFails: true });
      expect((yield* denied.request("POST", TEST_RUN_PATH, { role: "refiner" })).status).toBe(401);
      const readOnly = yield* serve({ root, scopes: [AuthOrchestrationReadScope] });
      expect((yield* readOnly.request("POST", TEST_RUN_PATH, { role: "refiner" })).status).toBe(
        403,
      );
      yield* registerPromptAdvisor("test", advisor(reply("x")));
      const api = yield* serve({ root });
      for (const body of [
        {},
        { role: "advisor" },
        { role: "advisor", scenario: "other" },
        { role: "refiner", mode: "wild" },
        { role: "nobody" },
      ]) {
        const result = yield* api.request("POST", TEST_RUN_PATH, body);
        expect(result.status, JSON.stringify(body)).toBe(400);
      }
      expect((yield* api.request("POST", TEST_RUN_PATH, "{nope", { raw: true })).status).toBe(400);
    }),
  ),
);

it.live("answers 503 with the live status while no advisor is available", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
        role: "refiner",
      });
      expect(result.status).toBe(503);
      expect(typeof result.json.error).toBe("string");
      expect(result.json.status).toMatchObject({ advisor: { state: "unavailable" } });
    }),
  ),
);

it.live("runs each advisor scenario on the effective config and reports what it did", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const seen: Array<{ texts: Array<string>; hasExplicitChoices: boolean }> = [];
      yield* registerPromptAdvisor(
        "test",
        stubPromptAdvisorRuntime({
          sample: (input) =>
            Effect.sync(() => {
              seen.push({
                texts: input.messages.map((message) => message.text),
                hasExplicitChoices: input.hasExplicitChoices,
              });
              return encodedItems({ kind: "challenge", label: "盲点", fill: "你验证过吗？" });
            }),
        }),
      );
      const api = yield* serve({ root });
      for (const scenario of ["vague", "debugging", "explicit_choices"]) {
        const result = yield* api.request("POST", TEST_RUN_PATH, { role: "advisor", scenario });
        expect(result.status, scenario).toBe(200);
        expect(result.json).toMatchObject({
          role: "advisor",
          items: [{ kind: "challenge", label: "盲点", fill: "你验证过吗？" }],
          status: { advisor: { resolvedInstanceId: "test" } },
        });
        expect(typeof result.json.durationMs).toBe("number");
      }
      expect(seen.map(({ hasExplicitChoices }) => hasExplicitChoices)).toEqual([
        false,
        false,
        true,
      ]);
      expect(seen[1]?.texts[0]).toContain("401");
      expect(seen[2]?.texts.at(-1)).toContain("待你定");
    }),
  ),
);

it.live("returns an empty item list when the advisor finds nothing worth saying", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor("test", stubPromptAdvisorRuntime());
      const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
        role: "advisor",
        scenario: "vague",
      });
      expect(result.status).toBe(200);
      expect(result.json.items).toEqual([]);
    }),
  ),
);

it.live("runs the refiner sample in the chosen mode with its saved directive", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const prompts: Array<string> = [];
      yield* registerPromptAdvisor("test", advisor(reply("改写后的草稿"), prompts));
      const api = yield* serve({ root });
      yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG });
      const bold = yield* api.request("POST", TEST_RUN_PATH, { role: "refiner", mode: "bold" });
      expect(bold.json).toMatchObject({ role: "refiner", refined: "改写后的草稿" });
      expect(prompts[0]).toContain("Mode bold");
      const structured = yield* api.request("POST", TEST_RUN_PATH, { role: "refiner" });
      expect(structured.status).toBe(200);
      expect(prompts[1]).toContain("只把草稿改成三句话。");
      expect(prompts[1]).not.toContain("Mode structured");
    }),
  ),
);

it.live("answers 502 with a readable error and the latest status when the run fails", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const failing = new TextGenerationError({
        operation: "samplePromptAdvisor",
        detail: "Antigravity advisor timed out.",
      });
      yield* registerPromptAdvisor(
        "test",
        stubPromptAdvisorRuntime({
          sample: () => Effect.fail(failing),
          runPrompt: () => Effect.fail(failing),
        }),
      );
      const api = yield* serve({ root });
      for (const body of [
        { role: "advisor", scenario: "debugging" },
        { role: "refiner", mode: "scoped" },
      ]) {
        const result = yield* api.request("POST", TEST_RUN_PATH, body);
        expect(result.status).toBe(502);
        expect(result.json.error).toBe("Antigravity advisor timed out.");
        expect(result.json.status).toMatchObject({ refiner: { resolvedInstanceId: "test" } });
      }
    }),
  ),
);

describe("saving a config restarts only the helpers whose wording changed", () => {
  const releasing = (releases: Array<ReadonlyArray<string>>) =>
    stubPromptAdvisorRuntime({
      release: (signatures) => Effect.sync(() => void releases.push([...signatures].toSorted())),
    });
  const apart = (patch: {
    readonly lenses?: PromptAdvisorConfig["advisor"]["lenses"];
    readonly structured?: string;
  }): PromptAdvisorConfig => ({
    ...DEFAULT_PROMPT_ADVISOR_CONFIG,
    advisor: {
      ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
      runtime: { instanceId: null, model: "gemini-4-neon", thinking: null },
      lenses: patch.lenses ?? DEFAULT_PROMPT_ADVISOR_CONFIG.advisor.lenses,
    },
    refiner: {
      ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
      followAdvisorRuntime: false,
      runtime: { instanceId: null, model: "gemini-4-carbon", thinking: null },
      modeOverrides: {
        ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner.modeOverrides,
        structured: patch.structured ?? "",
      },
    },
  });
  const advisorSignature = targetSignature({ model: "gemini-4-neon", thinking: null });
  const refinerSignature = targetSignature({ model: "gemini-4-carbon", thinking: null });

  it.live("an advisor wording change releases only the advisor's helper", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const releases: Array<ReadonlyArray<string>> = [];
        yield* registerPromptAdvisor("test", releasing(releases));
        const api = yield* serve({ root });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: apart({}) });
        expect(releases).toEqual([]);
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
          config: apart({ lenses: { grilling: false, debugging: true, blastRadius: true } }),
        });
        expect(releases).toEqual([[advisorSignature]]);
      }),
    ),
  );

  it.live("a refiner wording change releases only the refiner's helper", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const releases: Array<ReadonlyArray<string>> = [];
        yield* registerPromptAdvisor("test", releasing(releases));
        const api = yield* serve({ root });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: apart({}) });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
          config: apart({ structured: "新的优化指令" }),
        });
        expect(releases).toEqual([[refinerSignature]]);
      }),
    ),
  );

  it.live("a shared helper is released once whichever side changed", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const releases: Array<ReadonlyArray<string>> = [];
        yield* registerPromptAdvisor("test", releasing(releases));
        const api = yield* serve({ root });
        const sharedSignature = targetSignature({ model: null, thinking: null });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
          config: {
            ...DEFAULT_PROMPT_ADVISOR_CONFIG,
            advisor: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor, customAppendix: "追加一句" },
          },
        });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
          config: {
            ...DEFAULT_PROMPT_ADVISOR_CONFIG,
            advisor: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor, customAppendix: "追加一句" },
            refiner: {
              ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
              modeOverrides: { structured: "改一下", bold: "", scoped: "" },
            },
          },
        });
        expect(releases).toEqual([[sharedSignature], [sharedSignature]]);
      }),
    ),
  );

  it.live("saving the same wording again, or only a model change, releases nothing", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const releases: Array<ReadonlyArray<string>> = [];
        yield* registerPromptAdvisor("test", releasing(releases));
        const api = yield* serve({ root });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG });
        releases.length = 0;
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, { config: CUSTOM_CONFIG });
        yield* api.request("PUT", PROMPT_ADVISOR_CONFIG_PATH, {
          config: {
            ...CUSTOM_CONFIG,
            advisor: {
              ...CUSTOM_CONFIG.advisor,
              runtime: { instanceId: null, model: "gemini-4-carbon", thinking: null },
            },
          },
        });
        expect(releases).toEqual([]);
      }),
    ),
  );
});

const DRAFT_CONFIG: PromptAdvisorConfig = {
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  advisor: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
    runtime: { instanceId: null, model: "gemini-4-carbon", thinking: "high" },
    customAppendix: "草稿里才有的补充指令。",
  },
  refiner: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
    modeOverrides: { structured: "草稿里的优化指令。", bold: "", scoped: "" },
  },
};
const LIVE = {
  activeModel: "gemini-4-carbon",
  activeThinking: "high",
  availableModels: ["gemini-4-carbon"],
  availableThinking: ["high"],
};

describe("test runs of an unsaved draft", () => {
  /** A runtime that records which entry each call took. */
  const watched = (output: string) => {
    const calls = {
      sample: 0,
      runPrompt: 0,
      retain: 0,
      release: 0,
      isolated: [] as Array<{ prompt: string; model: string | null; thinking: string | null }>,
    };
    const runtime = stubPromptAdvisorRuntime({
      sample: () => Effect.sync(() => (calls.sample++, null)),
      runPrompt: () => Effect.sync(() => (calls.runPrompt++, "{}")),
      retain: () => Effect.sync(() => void calls.retain++),
      release: () => Effect.sync(() => void calls.release++),
      runIsolated: (prompt, target) =>
        Effect.sync(() => {
          calls.isolated.push({ prompt, model: target.model, thinking: target.thinking });
          return { output, live: LIVE };
        }),
    });
    return { calls, runtime };
  };

  it.live(
    "runs an advisor draft on a one-off helper and touches neither the saved config nor the slots",
    () =>
      withWorkspace((root) =>
        Effect.gen(function* () {
          const { calls, runtime } = watched(
            JSON.stringify({
              items: [{ kind: "next", label: "先复现", fill: "先复现这个失败。" }],
            }),
          );
          yield* registerPromptAdvisor("test", runtime);
          const api = yield* serve({ root });
          const result = yield* api.request("POST", TEST_RUN_PATH, {
            role: "advisor",
            scenario: "debugging",
            config: DRAFT_CONFIG,
          });
          expect(result.status).toBe(200);
          expect(result.json).toMatchObject({
            role: "advisor",
            draft: true,
            ran: {
              resolvedInstanceId: "test",
              activeModel: "gemini-4-carbon",
              activeThinking: "high",
            },
            items: [{ kind: "next", label: "先复现", fill: "先复现这个失败。" }],
            dropped: 0,
          });
          expect(calls.isolated).toHaveLength(1);
          expect(calls.isolated[0]).toMatchObject({ model: "gemini-4-carbon", thinking: "high" });
          expect(calls.isolated[0]?.prompt).toContain("草稿里才有的补充指令。");
          expect(calls).toMatchObject({ sample: 0, runPrompt: 0, retain: 0, release: 0 });
          const saved = (yield* api.request("GET", PROMPT_ADVISOR_CONFIG_PATH)).json as unknown as {
            config: PromptAdvisorConfig;
          };
          expect(saved.config).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
          expect(yield* (yield* FileSystem.FileSystem).exists(api.configFile)).toBe(false);
        }),
      ),
  );

  it.live("runs a refiner draft with the draft's directive and leaves the warm slot alone", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const { calls, runtime } = watched('{"refined":"草稿改写"}');
        yield* registerPromptAdvisor("test", runtime);
        const api = yield* serve({ root });
        const result = yield* api.request("POST", TEST_RUN_PATH, {
          role: "refiner",
          config: DRAFT_CONFIG,
        });
        expect(result.json).toMatchObject({
          draft: true,
          refined: "草稿改写",
          ran: { activeModel: "gemini-4-carbon" },
        });
        expect(calls.isolated[0]?.prompt).toContain("草稿里的优化指令。");
        expect(calls.runPrompt).toBe(0);
      }),
    ),
  );

  it.live("rejects an invalid draft with 400 before running anything", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const { calls, runtime } = watched("{}");
        yield* registerPromptAdvisor("test", runtime);
        const api = yield* serve({ root });
        for (const config of [{}, null, { ...DRAFT_CONFIG, version: 3 }]) {
          const result = yield* api.request("POST", TEST_RUN_PATH, { role: "refiner", config });
          expect(result.status, JSON.stringify(config)).toBe(400);
        }
        expect(calls.isolated).toHaveLength(0);
      }),
    ),
  );

  it.live("a saved-config run reports draft false and the slot it ran on", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        yield* registerPromptAdvisor("test", advisor(reply("改好了")));
        const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
          role: "refiner",
        });
        expect(result.json).toMatchObject({ draft: false, ran: { resolvedInstanceId: "test" } });
      }),
    ),
  );
});

describe("test runs tell broken output from an empty answer", () => {
  const reading = (value: PromptAdvisorOutputReading) =>
    stubPromptAdvisorRuntime({ sampleDetailed: () => Effect.succeed(value) });

  it.live("answers 502 with the reason and an excerpt when the output is not the agreed JSON", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        yield* registerPromptAdvisor(
          "test",
          reading({ _tag: "Unparseable", excerpt: "我觉得可以先看看" }),
        );
        const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
          role: "advisor",
          scenario: "vague",
        });
        expect(result.status).toBe(502);
        expect(result.json.error).toBe(
          "Advisor output was not valid JSON. It began: 我觉得可以先看看",
        );
        expect(result.json.status).toBeDefined();
      }),
    ),
  );

  it.live("does the same for an unsaved draft, quoting at most the excerpt the server kept", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        const long = "说".repeat(500);
        yield* registerPromptAdvisor(
          "test",
          stubPromptAdvisorRuntime({
            runIsolated: () => Effect.succeed({ output: long, live: LIVE }),
          }),
        );
        const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
          role: "advisor",
          scenario: "vague",
          config: DRAFT_CONFIG,
        });
        expect(result.status).toBe(502);
        const error = String(result.json.error);
        expect(error.startsWith("Advisor output was not valid JSON. It began: ")).toBe(true);
        expect(error.endsWith("说".repeat(240))).toBe(true);
        expect(error.includes("说".repeat(241))).toBe(false);
      }),
    ),
  );

  it.live("reports how many entries the rules removed instead of a silent zero", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        yield* registerPromptAdvisor(
          "test",
          reading({ _tag: "Parsed", encoded: null, received: 3, dropped: 3 }),
        );
        const api = yield* serve({ root });
        const filtered = yield* api.request("POST", TEST_RUN_PATH, {
          role: "advisor",
          scenario: "vague",
        });
        expect(filtered.status).toBe(200);
        expect(filtered.json).toMatchObject({ items: [], dropped: 3 });
      }),
    ),
  );

  it.live("a genuine empty answer carries no dropped entries", () =>
    withWorkspace((root) =>
      Effect.gen(function* () {
        yield* registerPromptAdvisor(
          "test",
          reading({ _tag: "Parsed", encoded: null, received: 0, dropped: 0 }),
        );
        const result = yield* (yield* serve({ root })).request("POST", TEST_RUN_PATH, {
          role: "advisor",
          scenario: "vague",
        });
        expect(result.json).toMatchObject({ items: [], dropped: 0 });
      }),
    ),
  );
});
