import { it } from "@effect/vitest";
import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  PROMPT_ADVISOR_PREFIX,
  type PromptAdvisorSampleInput,
  type PromptAdvisorSampler,
} from "../textGeneration/promptAdvisor.cn.ts";
import {
  listAdvisorSnapshots,
  resetAdvisorSnapshotsForTest,
} from "../textGeneration/sessionSpriteRegistry.cn.ts";
import {
  type PromptAdvisorServiceDeps,
  hasExplicitReplyChoices,
  makePromptAdvisorService,
} from "./promptAdvisorService.cn.ts";

const SENTINEL_THREAD = "thread-sentinel";
const ENCODED = `${PROMPT_ADVISOR_PREFIX}{"items":[{"kind":"challenge","label":"盲点","fill":"回归测试覆盖了吗？"}]}`;

const run = (id: string, threadId: string, extra: Partial<OrchestrationV2Run> = {}) =>
  ({
    id,
    threadId,
    status: "completed",
    userMessageId: `${id}-user`,
    ...extra,
  }) as unknown as OrchestrationV2Run;

const row = (position: number, item: Record<string, unknown>) =>
  ({
    position,
    visibility: "local",
    sourceThreadId: "t",
    sourceItemId: `i${position}`,
    item,
  }) as unknown as OrchestrationV2ProjectedTurnItem;

const userItem = (runId: string, text: string, extra: Record<string, unknown> = {}) =>
  row(0, {
    type: "user_message",
    messageId: `${runId}-user`,
    text,
    createdBy: "user",
    creationSource: "app",
    ...extra,
  });
const assistantItem = (text: string, extra: Record<string, unknown> = {}) =>
  row(1, { type: "assistant_message", text, ...extra });

const defaultRows = [userItem("run-1", "改一下"), assistantItem("改完了")];

interface Setup {
  readonly rows?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly thread?: Record<string, unknown> | null;
  readonly shell?: Record<string, unknown> | null;
  readonly advisor?: boolean;
  readonly enabled?: boolean;
  readonly sample?: PromptAdvisorSampler["sample"];
}

const makeHarness = Effect.fn("makePromptAdvisorHarness")(function* (setup: Setup = {}) {
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const published = yield* Queue.unbounded<{ threadId: ThreadId; runId: string; text: string }>();
  const calls: Array<PromptAdvisorSampleInput> = [];
  let latestRunId = "run-1";
  const sampler: PromptAdvisorSampler = {
    available: Effect.succeed(true),
    sample:
      setup.sample ??
      ((input) =>
        Effect.sync(() => {
          calls.push(input);
          return ENCODED;
        })),
  };
  const deps: PromptAdvisorServiceDeps = {
    enabled: Effect.succeed(setup.enabled ?? true),
    resolveAdvisor: Effect.succeed(setup.advisor === false ? Option.none() : Option.some(sampler)),
    eventSink: {
      latestSequence: () => Effect.succeed(0),
      stream: () => Stream.fromQueue(events),
    },
    projectionStore: {
      findThread: () =>
        Effect.succeed(
          (setup.thread === undefined
            ? { deletedAt: null, lineage: { relationshipToParent: null } }
            : setup.thread) as never,
        ),
      getThreadShell: (threadId) =>
        Effect.sync(
          () =>
            (setup.shell === undefined
              ? {
                  latestRunId: threadId === SENTINEL_THREAD ? "sentinel" : latestRunId,
                  activeRunId: null,
                }
              : setup.shell) as never,
        ),
      getMessagesById: (_threadId, ids) =>
        Effect.succeed(
          new Map(
            (setup.rows ?? defaultRows).flatMap(({ item }) =>
              item.type === "user_message" && ids.includes(item.messageId)
                ? [[item.messageId, item]]
                : [],
            ),
          ) as never,
        ),
      getTimelinePage: (_threadId, options) =>
        Effect.succeed({
          items: (setup.rows ?? defaultRows).slice(-options.limit),
          totalItems: 2,
          hasMore: false,
          hasEarlier: false,
        }),
    },
    publish: (threadId, suggestion) =>
      Queue.offer(published, { threadId, ...suggestion }).pipe(Effect.asVoid),
  };
  const service = yield* makePromptAdvisorService(deps);
  const emit = (runUpdate: OrchestrationV2Run) =>
    Queue.offer(events, {
      event: { type: "run.updated", threadId: runUpdate.threadId, payload: runUpdate },
    } as unknown as OrchestrationV2StoredEvent);
  return {
    service,
    emit,
    published,
    calls,
    moveLatestRun: (id: string) => {
      latestRunId = id;
    },
  };
});

/** A second thread's completed run publishes after the first one's handler has settled. */
const settle = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  harness
    .emit(run("sentinel", SENTINEL_THREAD, { userMessageId: "run-1-user" as never }))
    .pipe(Effect.andThen(Queue.take(harness.published)));

describe("hasExplicitReplyChoices", () => {
  it("两个以上带标号的选项，或「待你定」段，算显式选项", () => {
    expect(hasExplicitReplyChoices("**甲（推荐）**：快\n**乙**：稳")).toBe(true);
    expect(hasExplicitReplyChoices("- A. 保守\n- B. 激进")).toBe(true);
    expect(hasExplicitReplyChoices("做完了。\n\n## 待你定\n1. 合并吗？")).toBe(true);
  });

  it("单个标号或普通说明不算", () => {
    expect(hasExplicitReplyChoices("**甲**：只有一项")).toBe(false);
    expect(hasExplicitReplyChoices("Another approach works.\nA short note.")).toBe(false);
    expect(hasExplicitReplyChoices("改完了，测试通过。")).toBe(false);
  });
});

describe("上下文顾问服务", () => {
  it.effect("完成的 run 采样一次并写出编码串，普通回复 hasExplicitChoices 为 false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(run("run-1", "thread-1"));
      expect(yield* Queue.take(harness.published)).toEqual({
        threadId: "thread-1",
        runId: "run-1",
        text: ENCODED,
      });
      expect(harness.calls).toEqual([
        {
          messages: [
            { role: "user", text: "改一下" },
            { role: "assistant", text: "改完了" },
          ],
          hasExplicitChoices: false,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("末条回复带显式选项时 hasExplicitChoices 为 true，commentary 不进对话", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        rows: [
          userItem("run-1", "选哪个"),
          row(1, { type: "assistant_message", text: "我先看看", phase: "commentary" }),
          row(2, { type: "assistant_message", text: "**甲**：快\n**乙**：稳" }),
        ],
      });
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Queue.take(harness.published);
      expect(harness.calls[0]?.hasExplicitChoices).toBe(true);
      expect(harness.calls[0]?.messages.map((message) => message.text)).toEqual([
        "选哪个",
        "**甲**：快\n**乙**：稳",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("同一个 run 的重复 run.updated 只采样一次", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.emit(run("run-1", "thread-1"));
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Queue.take(harness.published);
      yield* settle(harness);
      expect(harness.calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("开关关闭、没有顾问、被删除线程、子会话与委派线程都不采样", () =>
    Effect.gen(function* () {
      for (const setup of [
        { enabled: false },
        { advisor: false },
        {
          thread: {
            deletedAt: "2026-01-01T00:00:00.000Z",
            lineage: { relationshipToParent: null },
          },
        },
        { thread: { deletedAt: null, lineage: { relationshipToParent: "subagent" } } },
        { thread: { deletedAt: null, lineage: { relationshipToParent: null }, delegatedFrom: {} } },
        { thread: null },
      ] satisfies ReadonlyArray<Setup>) {
        const harness = yield* makeHarness(setup);
        yield* harness.emit(run("run-1", "thread-1"));
        yield* harness.emit(run("run-2", "thread-2"));
        // The settle run lands on the same gates, so a leak would show as a publish before it.
        yield* Effect.yieldNow;
        expect(yield* Queue.size(harness.published)).toBe(0);
        expect(harness.calls).toHaveLength(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("分叉线程照常采样，避免原生预测关闭后既无顾问又无灰字", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: { deletedAt: null, lineage: { relationshipToParent: "fork" } },
      });
      yield* harness.emit(run("run-1", "thread-1"));
      expect(yield* Queue.take(harness.published)).toEqual({
        threadId: "thread-1",
        runId: "run-1",
        text: ENCODED,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("续跑、委派任务、唤醒、/compact 触发的 run 不采样", () =>
    Effect.gen(function* () {
      const skipped = [
        { runExtra: { restartContinuationOfRunId: "run-0" }, rows: undefined },
        { runExtra: { manualContinuationOfRunId: "run-0" }, rows: undefined },
        { runExtra: { delegatedTaskId: "task" }, rows: undefined },
        {
          runExtra: {},
          rows: [userItem("run-1", "/compact 保留要点"), assistantItem("已压缩")],
        },
        {
          runExtra: {},
          rows: [
            userItem("run-1", "后台任务有输出", { createdBy: "agent", creationSource: "provider" }),
            assistantItem("收到"),
          ],
        },
      ];
      for (const { runExtra, rows } of skipped) {
        const harness = yield* makeHarness(rows === undefined ? {} : { rows });
        yield* harness.emit(run("run-1", "thread-1", runExtra as Partial<OrchestrationV2Run>));
        yield* Effect.yieldNow;
        expect(harness.calls).toHaveLength(0);
        expect(yield* Queue.size(harness.published)).toBe(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("run 里的 commentary 把触发消息挤出时间线页时，仍带上用户消息采样", () =>
    Effect.gen(function* () {
      const commentary = Array.from({ length: 60 }, (_, index) =>
        row(index + 1, {
          type: "assistant_message",
          text: `看第 ${index} 个文件`,
          phase: "commentary",
        }),
      );
      const harness = yield* makeHarness({
        rows: [userItem("run-1", "改一下"), ...commentary, assistantItem("改完了")],
      });
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Queue.take(harness.published);
      expect(harness.calls[0]?.messages).toEqual([
        { role: "user", text: "改一下" },
        { role: "assistant", text: "改完了" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("采样期间最新 run 变了就丢弃结果", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        sample: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(ENCODED),
          ),
      });
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Deferred.await(entered);
      harness.moveLatestRun("run-2");
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.yieldNow;
      expect(yield* Queue.size(harness.published)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("同一线程的新 run 开始时立刻取消进行中的采样", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        sample: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Deferred.await(entered);
      yield* harness.emit(run("run-2", "thread-1", { status: "running" }));
      yield* Deferred.await(interrupted);
      expect(yield* Queue.size(harness.published)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("采样器返回 null 时不写入", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ sample: () => Effect.succeed(null) });
      yield* harness.emit(run("run-1", "thread-1"));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(harness.published)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("原生预测只在开关开着且没有顾问时放行", () =>
    Effect.gen(function* () {
      const native = (setup: Setup) =>
        makeHarness(setup).pipe(Effect.flatMap((harness) => harness.service.nativeSuggestions));
      expect(yield* native({ enabled: true, advisor: false })).toBe(true);
      expect(yield* native({ enabled: true, advisor: true })).toBe(false);
      expect(yield* native({ enabled: false, advisor: false })).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("发布建议后登记小精灵快照并截断末条回复，新 run 开始时清理快照", () =>
    Effect.gen(function* () {
      resetAdvisorSnapshotsForTest();
      const longReply = `${"前".repeat(400)}${"尾".repeat(1_500)}`;
      const harness = yield* makeHarness({
        rows: [userItem("run-1", "改一下"), assistantItem(longReply)],
      });
      yield* harness.emit(run("run-1", "thread-snap"));
      yield* Queue.take(harness.published);
      const saved = listAdvisorSnapshots().find((entry) => entry.threadId === "thread-snap");
      expect(saved).toMatchObject({
        threadId: "thread-snap",
        runId: "run-1",
        encoded: ENCODED,
        hasExplicitChoices: false,
        lastReplyExcerpt: "尾".repeat(1_500),
      });
      yield* harness.emit(run("run-2", "thread-snap", { status: "running" }));
      yield* settle(harness);
      expect(listAdvisorSnapshots().some((entry) => entry.threadId === "thread-snap")).toBe(false);
      resetAdvisorSnapshotsForTest();
    }).pipe(Effect.scoped),
  );
});
