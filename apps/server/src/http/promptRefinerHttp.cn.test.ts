import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
import type * as Scope from "effect/Scope";
import { HttpBody, HttpRouter, HttpServer } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { PromptAdvisorRuntime } from "../textGeneration/promptAdvisor.cn.ts";
import { registerPromptAdvisor } from "../textGeneration/promptAdvisorRegistry.cn.ts";
import { PROMPT_REFINE_PATH, promptRefinerRouteLayer } from "./promptRefinerHttp.cn.ts";

const SESSION = {
  sessionId: AuthSessionId.make("refiner-test"),
  subject: "refiner-test",
  method: "bearer-access-token" as const,
};

const advisor = (
  runPrompt: PromptAdvisorRuntime["runPrompt"],
  prompts: Array<string> = [],
): PromptAdvisorRuntime => ({
  available: Effect.succeed(true),
  sample: () => Effect.succeed(null),
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
}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(promptRefinerRouteLayer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
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
    return (body: unknown, init?: { readonly raw?: boolean }) =>
      HttpClient.execute(
        HttpClientRequest.post(
          `http://${origin.replace(/^http:\/\//, "")}${PROMPT_REFINE_PATH}`,
        ).pipe(
          HttpClientRequest.setBody(
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
  });

const withWorkspace = <A, E>(
  body: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
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
