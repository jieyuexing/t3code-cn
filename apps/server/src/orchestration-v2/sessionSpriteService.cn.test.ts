import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { TextGenerationError, type ProjectId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import { PROMPT_ADVISOR_PREFIX } from "../textGeneration/promptAdvisor.cn.ts";
import { stubPromptAdvisorRuntime } from "../textGeneration/promptAdvisor.testkit.cn.ts";
import {
  DEFAULT_PROMPT_ADVISOR_CONFIG,
  type PromptAdvisorConfig,
} from "../textGeneration/promptAdvisorConfig.cn.ts";
import {
  SESSION_SPRITE_NON_AUTH_HEADER,
  readSessionSpriteLedger,
} from "../textGeneration/sessionSprite.cn.ts";
import type { SessionSpriteAdvisorSnapshot } from "../textGeneration/sessionSpriteRegistry.cn.ts";
import {
  makeSessionSpriteBackgroundLayer,
  runSessionSpriteScan,
} from "./sessionSpriteService.cn.ts";

const NOW = Date.UTC(2026, 10, 26, 14, 0, 0);

const encoded = (
  ...items: ReadonlyArray<{ kind: "challenge" | "next" | "angle"; label: string; fill: string }>
) => `${PROMPT_ADVISOR_PREFIX}${JSON.stringify({ items })}`;

const snapshot = (
  threadId: string,
  runId: string,
  patch: Partial<SessionSpriteAdvisorSnapshot> = {},
): SessionSpriteAdvisorSnapshot => ({
  threadId: threadId as ThreadId,
  runId: runId as RunId,
  encoded: encoded({
    kind: "challenge",
    label: "核验影响面",
    fill: "请只读核验 diff 外还有哪些调用方受影响，不要改代码。",
  }),
  hasExplicitChoices: false,
  lastReplyExcerpt: "已完成修改。",
  sampledAt: NOW - 10 * 60_000,
  ...patch,
});

const threadDoc = (threadId: string, patch: Record<string, unknown> = {}) =>
  ({
    id: threadId as ThreadId,
    projectId: "proj-1" as ProjectId,
    title: "重构个人博客搜索",
    worktreePath: "/Users/jieyuexing/code/planet-blog",
    deletedAt: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    delegatedFrom: undefined,
    ...patch,
  }) as never;

const shellDoc = (patch: Record<string, unknown> = {}) =>
  ({
    activeRunId: null,
    deletedAt: null,
    pendingRuntimeRequest: null,
    latestUserAuthoredMessageAt: DateTime.makeUnsafe(NOW - 12 * 60_000),
    latestUserMessageAt: DateTime.makeUnsafe(NOW - 12 * 60_000),
    ...patch,
  }) as never;

const enabledConfig: PromptAdvisorConfig = {
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  sprite: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.sprite,
    enabled: true,
    quietHoursEnabled: false,
  },
};

describe("sessionSpriteService", () => {
  it.layer(NodeServices.layer)("影子扫描全流程", (it) => {
    it.effect("安全线程命中 would_advance 且带非授权头，公司线硬拦不调模型", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sprite-svc-" });
        const ledgerPath = path.join(dir, "cn-session-sprite.jsonl");
        let modelCalls = 0;

        const snapshots = [snapshot("t-company", "r-1"), snapshot("t-safe", "r-2")];
        const threads = new Map<string, ReturnType<typeof threadDoc>>([
          [
            "t-company",
            threadDoc("t-company", { title: "GWH-101 联调", worktreePath: "/Users/me/work/gwh" }),
          ],
          ["t-safe", threadDoc("t-safe")],
        ]);

        const result = yield* runSessionSpriteScan(
          {
            projectionStore: {
              findThread: (id) => Effect.succeed(threads.get(id) ?? null),
              getThreadShell: (id) => Effect.succeed(threads.has(id) ? shellDoc() : null),
            },
            ledgerPath,
            readConfig: () => enabledConfig,
            readSnapshots: () => snapshots,
            now: Effect.succeed(NOW),
            resolveAdvisor: Effect.succeedSome(
              stubPromptAdvisorRuntime({
                runPrompt: () => {
                  modelCalls += 1;
                  return Effect.succeed(
                    JSON.stringify({
                      decisions: [{ index: 0, grade: "A", reason: "纯只读核验" }],
                    }),
                  );
                },
              }),
            ),
          },
          { trigger: "periodic" },
        );

        expect(modelCalls).toBe(1);
        expect(result.scanned).toBe(2);
        expect(result.blocked).toBe(1);
        expect(result.wouldAdvance).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.entries[0]?.decision).toBe("would_advance");
        expect(result.entries[0]?.draftMessage?.startsWith(SESSION_SPRITE_NON_AUTH_HEADER)).toBe(
          true,
        );
        expect(result.entries[1]).toMatchObject({
          threadId: "t-company",
          decision: "blocked_thread",
          blockReason: "company_or_blocked_scope",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("模型不可用或失败记 error，且下一次扫描仍可重新评估同一 run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sprite-err-" });
        const ledgerPath = path.join(dir, "cn-session-sprite.jsonl");
        const snaps = [snapshot("t-safe", "r-1")];
        const projectionStore = {
          findThread: () => Effect.succeed(threadDoc("t-safe")),
          getThreadShell: () => Effect.succeed(shellDoc()),
        };

        const unavailable = yield* runSessionSpriteScan(
          {
            projectionStore,
            ledgerPath,
            readConfig: () => enabledConfig,
            readSnapshots: () => snaps,
            now: Effect.succeed(NOW),
            resolveAdvisor: Effect.succeedNone,
          },
          { trigger: "periodic" },
        );
        expect(unavailable).toMatchObject({ scanned: 1, errors: 1, wouldAdvance: 0 });
        expect(unavailable.entries[0]?.blockReason).toBe("advisor_unavailable");

        const failedRun = yield* runSessionSpriteScan(
          {
            projectionStore,
            ledgerPath,
            readConfig: () => enabledConfig,
            readSnapshots: () => snaps,
            now: Effect.succeed(NOW + 1_000),
            resolveAdvisor: Effect.succeedSome(
              stubPromptAdvisorRuntime({
                runPrompt: () =>
                  Effect.fail(
                    new TextGenerationError({ operation: "samplePromptAdvisor", detail: "boom" }),
                  ),
              }),
            ),
          },
          { trigger: "periodic" },
        );
        expect(failedRun.errors).toBe(1);
        expect(failedRun.entries[0]?.blockReason).toBe("boom");

        const recovered = yield* runSessionSpriteScan(
          {
            projectionStore,
            ledgerPath,
            readConfig: () => enabledConfig,
            readSnapshots: () => snaps,
            now: Effect.succeed(NOW + 2_000),
            resolveAdvisor: Effect.succeedSome(
              stubPromptAdvisorRuntime({
                runPrompt: () =>
                  Effect.succeed(
                    JSON.stringify({ decisions: [{ index: 0, grade: "A", reason: "只读" }] }),
                  ),
              }),
            ),
          },
          { trigger: "periodic" },
        );
        expect(recovered.wouldAdvance).toBe(1);
        expect((yield* readSessionSpriteLedger(ledgerPath)).summary.totalEvaluated).toBe(3);
      }).pipe(Effect.scoped),
    );

    it.effect("单次定期扫描最多命中 1 条 would_advance；确定性护栏阻止伪装成 A 的授权项", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sprite-cap-" });
        const ledgerPath = path.join(dir, "cn-session-sprite.jsonl");
        let calls = 0;

        const snaps = [
          snapshot("t-auth", "r-0", {
            encoded: encoded({ kind: "next", label: "立项", fill: "正式立项并推送部署。" }),
          }),
          snapshot("t-1", "r-1"),
          snapshot("t-2", "r-2"),
        ];
        const projectionStore = {
          findThread: (id: string) => Effect.succeed(threadDoc(id)),
          getThreadShell: () => Effect.succeed(shellDoc()),
        };

        const result = yield* runSessionSpriteScan(
          {
            projectionStore,
            ledgerPath,
            readConfig: () => enabledConfig,
            readSnapshots: () => snaps,
            now: Effect.succeed(NOW),
            resolveAdvisor: Effect.succeedSome(
              stubPromptAdvisorRuntime({
                runPrompt: () => {
                  calls += 1;
                  return Effect.succeed(
                    JSON.stringify({ decisions: [{ index: 0, grade: "A", reason: "ok" }] }),
                  );
                },
              }),
            ),
          },
          { trigger: "periodic" },
        );

        expect(calls).toBe(2);
        expect(result.scanned).toBe(2);
        expect(result.blocked).toBe(1);
        expect(result.wouldAdvance).toBe(1);
        expect(result.entries[1]).toMatchObject({
          threadId: "t-auth",
          decision: "blocked_items",
          draftMessage: null,
        });
        expect(result.entries[0]?.threadId).toBe("t-1");
      }).pipe(Effect.scoped),
    );

    it.effect("后台轮询层可正常建立与销毁，不泄漏定时 fiber", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sprite-bg-" });
        yield* Layer.build(
          makeSessionSpriteBackgroundLayer({
            projectionStore: {
              findThread: () => Effect.succeed(null),
              getThreadShell: () => Effect.succeed(null),
            },
            ledgerPath: path.join(dir, "cn-session-sprite.jsonl"),
          }),
        );
      }).pipe(Effect.scoped),
    );
  });
});
