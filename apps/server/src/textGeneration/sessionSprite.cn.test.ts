import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import type { PromptAdvisorItem } from "./promptAdvisor.cn.ts";
import { DEFAULT_SESSION_SPRITE_CONFIG } from "./promptAdvisorConfig.cn.ts";
import {
  SESSION_SPRITE_NON_AUTH_HEADER,
  type SessionSpriteLedgerEntry,
  type SessionSpriteThreadCandidate,
  appendSessionSpriteLedgerEntry,
  buildSessionSpriteTriagePrompt,
  countRecentWouldAdvance,
  evaluateThreadEligibility,
  formatSpriteDraftMessage,
  isWithinQuietHours,
  matchesAuthOrWriteGuard,
  parseSessionSpriteTriage,
  readSessionSpriteLedger,
} from "./sessionSprite.cn.ts";
import {
  clearAdvisorSnapshot,
  listAdvisorSnapshots,
  recordAdvisorSnapshot,
  resetAdvisorSnapshotsForTest,
} from "./sessionSpriteRegistry.cn.ts";

const NOW = Date.UTC(2026, 10, 26, 14, 0, 0);

const baseCandidate = (
  patch: Partial<SessionSpriteThreadCandidate> = {},
): SessionSpriteThreadCandidate => ({
  threadId: "thread-1",
  runId: "run-1",
  threadTitle: "重构个人博客搜索索引",
  deletedAt: null,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  activeRunId: null,
  relationshipToParent: null,
  delegatedFrom: undefined,
  scheduledTaskId: undefined,
  pendingRequestCount: 0,
  hasExplicitChoices: false,
  worktreePath: "/Users/jieyuexing/code/planet-blog",
  workspaceRoot: "/Users/jieyuexing/code/planet-blog",
  sampledAt: NOW - 10 * 60_000,
  lastHumanMessageAt: NOW - 12 * 60_000,
  ...patch,
});

const ledgerEntry = (patch: Partial<SessionSpriteLedgerEntry> = {}): SessionSpriteLedgerEntry => ({
  ts: DateTime.formatIso(DateTime.makeUnsafe(NOW - 5 * 60_000)),
  mode: "shadow",
  trigger: "periodic",
  threadId: "thread-1",
  threadTitle: "重构个人博客搜索索引",
  runId: "run-0",
  decision: "would_advance",
  blockReason: null,
  keptItems: [{ kind: "challenge", label: "查边界", fill: "请只读核验空查询行为。" }],
  droppedItems: [],
  draftMessage: `${SESSION_SPRITE_NON_AUTH_HEADER}\n\n请仅做只读核验并逐条回应以下几点：\n1. 请只读核验空查询行为。`,
  durationMs: 120,
  ...patch,
});

describe("sessionSpriteRegistry", () => {
  it("按 threadId 覆盖更新，支持清理并按 LRU 限制 128 条上限", () => {
    resetAdvisorSnapshotsForTest();
    for (let index = 0; index < 130; index += 1) {
      recordAdvisorSnapshot({
        threadId: `t-${index}` as ThreadId,
        runId: `r-${index}` as RunId,
        encoded: "x",
        hasExplicitChoices: false,
        lastReplyExcerpt: "ok",
        sampledAt: index,
      });
    }
    const list = listAdvisorSnapshots();
    expect(list).toHaveLength(128);
    expect(list.some((item) => item.threadId === "t-0")).toBe(false);
    expect(list.some((item) => item.threadId === "t-1")).toBe(false);
    expect(list[0]?.threadId).toBe("t-129");

    clearAdvisorSnapshot("t-129" as ThreadId);
    expect(listAdvisorSnapshots().some((item) => item.threadId === "t-129")).toBe(false);
    resetAdvisorSnapshotsForTest();
  });
});

describe("闸门 1：静默时段与全局限流", () => {
  it("正确处理跨午夜（22→8）、同日（1→6）及起止相等情况", () => {
    const baseHour = DateTime.toDate(DateTime.makeUnsafe(NOW)).getHours();
    const atHour = (hour: number) =>
      DateTime.toDate(DateTime.makeUnsafe(NOW + (hour - baseHour) * 3_600_000));
    expect(isWithinQuietHours(atHour(22), 22, 8)).toBe(true);
    expect(isWithinQuietHours(atHour(23), 22, 8)).toBe(true);
    expect(isWithinQuietHours(atHour(0), 22, 8)).toBe(true);
    expect(isWithinQuietHours(atHour(7), 22, 8)).toBe(true);
    expect(isWithinQuietHours(atHour(8), 22, 8)).toBe(false);
    expect(isWithinQuietHours(atHour(15), 22, 8)).toBe(false);

    expect(isWithinQuietHours(atHour(1), 1, 6)).toBe(true);
    expect(isWithinQuietHours(atHour(5), 1, 6)).toBe(true);
    expect(isWithinQuietHours(atHour(6), 1, 6)).toBe(false);
    expect(isWithinQuietHours(atHour(0), 1, 6)).toBe(false);

    expect(isWithinQuietHours(atHour(10), 10, 10)).toBe(false);
  });

  it("仅统计过去 60 分钟窗口内的 would_advance 记录", () => {
    const isoAt = (minutesAgo: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(NOW - minutesAgo * 60_000));
    const entries = [
      ledgerEntry({ ts: isoAt(10), decision: "would_advance" }),
      ledgerEntry({ ts: isoAt(59), decision: "would_advance" }),
      ledgerEntry({ ts: isoAt(61), decision: "would_advance" }),
      ledgerEntry({ ts: isoAt(5), decision: "blocked_thread" }),
      ledgerEntry({ ts: isoAt(5), decision: "error" }),
    ];
    expect(countRecentWouldAdvance(entries, NOW)).toBe(2);
  });
});

describe("闸门 2：线程资格硬门", () => {
  it("安全空闲线程放行", () => {
    expect(
      evaluateThreadEligibility(baseCandidate(), DEFAULT_SESSION_SPRITE_CONFIG, [], NOW),
    ).toEqual({ ok: true });
  });

  it("拦截已删、归档、settled、snoozed、运行中、子会话、委派、定时任务、待决请求、显式选项", () => {
    const cases: Array<[Partial<SessionSpriteThreadCandidate>, string]> = [
      [{ deletedAt: NOW - 1_000 }, "deleted"],
      [{ archivedAt: NOW - 1_000 }, "archived"],
      [{ settledOverride: "settled" }, "settled"],
      [{ settledAt: NOW - 1_000 }, "settled"],
      [{ snoozedUntil: NOW + 60_000 }, "snoozed"],
      [{ activeRunId: "run-active" }, "running"],
      [{ relationshipToParent: "subagent" }, "subagent_or_delegated"],
      [{ delegatedFrom: { threadId: "parent" } }, "subagent_or_delegated"],
      [{ scheduledTaskId: "sched-1" }, "scheduled_task"],
      [{ threadTitle: "每日定时任务检查" }, "scheduled_task"],
      [{ pendingRequestCount: 1 }, "pending_request"],
      [{ hasExplicitChoices: true }, "explicit_choices"],
    ];
    for (const [patch, reason] of cases) {
      expect(
        evaluateThreadEligibility(baseCandidate(patch), DEFAULT_SESSION_SPRITE_CONFIG, [], NOW),
        reason,
      ).toEqual({ ok: false, reason });
    }
    expect(
      evaluateThreadEligibility(
        baseCandidate({ snoozedUntil: NOW - 1_000, relationshipToParent: "fork" }),
        DEFAULT_SESSION_SPRITE_CONFIG,
        [],
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it("拦截公司/敏感范围（work 路径与大小写不敏感关键词）", () => {
    for (const patch of [
      { worktreePath: "/Users/me/jieyuexing-universe/work/gwh" },
      { worktreePath: "C:\\repo\\work\\app" },
      { worktreePath: "/Users/me/work" },
      { worktreePath: null, workspaceRoot: "/Users/me/jieyuexing-universe/work/costman" },
      { threadTitle: "排查 gwh-412 异常" },
      { threadTitle: "etech 网关配置" },
      { threadTitle: "台式机 WSL 维护" },
      { threadTitle: "周末代码巡检" },
    ] satisfies Array<Partial<SessionSpriteThreadCandidate>>) {
      expect(
        evaluateThreadEligibility(baseCandidate(patch), DEFAULT_SESSION_SPRITE_CONFIG, [], NOW),
      ).toEqual({ ok: false, reason: "company_or_blocked_scope" });
    }
  });

  it("拦截冷却不足，支持 bypassIdle；拦截重复非 error run（error 允许重测）", () => {
    const fresh = baseCandidate({ sampledAt: NOW - 2 * 60_000 });
    expect(evaluateThreadEligibility(fresh, DEFAULT_SESSION_SPRITE_CONFIG, [], NOW)).toEqual({
      ok: false,
      reason: "not_idle_enough",
    });
    expect(
      evaluateThreadEligibility(fresh, DEFAULT_SESSION_SPRITE_CONFIG, [], NOW, {
        bypassIdle: true,
      }),
    ).toEqual({ ok: true });

    const errorOnly = [ledgerEntry({ runId: "run-1", decision: "error", blockReason: "timeout" })];
    expect(
      evaluateThreadEligibility(baseCandidate(), DEFAULT_SESSION_SPRITE_CONFIG, errorOnly, NOW),
    ).toEqual({ ok: true });

    const blockedBefore = [
      ledgerEntry({ runId: "run-1", decision: "blocked_items", blockReason: "no_a_grade_items" }),
    ];
    expect(
      evaluateThreadEligibility(baseCandidate(), DEFAULT_SESSION_SPRITE_CONFIG, blockedBefore, NOW),
    ).toEqual({ ok: false, reason: "already_evaluated_run" });
  });

  it("同一人类消息轮次内达到上限拦截，新人类消息后重置计数", () => {
    const entries = [
      ledgerEntry({
        runId: "run-0",
        ts: DateTime.formatIso(DateTime.makeUnsafe(NOW - 8 * 60_000)),
        decision: "would_advance",
      }),
    ];
    expect(
      evaluateThreadEligibility(
        baseCandidate({ runId: "run-1", lastHumanMessageAt: NOW - 12 * 60_000 }),
        DEFAULT_SESSION_SPRITE_CONFIG,
        entries,
        NOW,
      ),
    ).toEqual({ ok: false, reason: "thread_turn_cap_reached" });

    expect(
      evaluateThreadEligibility(
        baseCandidate({ runId: "run-1", lastHumanMessageAt: NOW - 5 * 60_000 }),
        DEFAULT_SESSION_SPRITE_CONFIG,
        entries,
        NOW,
      ),
    ).toEqual({ ok: true });
  });
});

describe("闸门 3：Neon 分级解析与确定性二次护栏", () => {
  const items: ReadonlyArray<PromptAdvisorItem> = [
    {
      kind: "challenge",
      label: "查调用方",
      fill: "请只读核验 diff 外还有哪些调用方受影响，不要改代码。",
    },
    { kind: "next", label: "顺手修", fill: "顺便把那个小 typo 改一下。" },
    { kind: "next", label: "选甲", fill: "选甲，正式立项并可以改 hosts 测试。" },
  ];

  it("构建分级提示词包含上下文定界符与独立请求声明", () => {
    const prompt = buildSessionSpriteTriagePrompt({
      threadTitle: "测试主题",
      lastReplyExcerpt: "我改完了。",
      items,
    });
    expect(prompt).toContain("BEGIN THREAD CONTEXT");
    expect(prompt).toContain("TITLE: 测试主题");
    expect(prompt).toContain("Each request is independent");
  });

  it("正常解析 A/B/C，缺失或非法 grade 按 C 拦截，损坏 JSON 返回 Unparseable", () => {
    const parsed = parseSessionSpriteTriage(
      `\`\`\`json\n{"decisions":[{"index":0,"grade":"A","reason":"纯只读核验"},{"index":1,"grade":"B","reason":"改代码"}]}\n\`\`\``,
      items.slice(0, 3),
    );
    expect(parsed._tag).toBe("Parsed");
    if (parsed._tag !== "Parsed") return;
    expect(parsed.keptItems).toEqual([items[0]]);
    expect(parsed.droppedItems).toEqual([
      { ...items[1], grade: "B", reason: "改代码" },
      { ...items[2], grade: "C", reason: "missing-decision" },
    ]);

    const invalidGrade = parseSessionSpriteTriage(
      JSON.stringify({ decisions: [{ index: 0, grade: "Z", reason: "bad" }] }),
      [items[0]!],
    );
    expect(invalidGrade).toEqual({
      _tag: "Parsed",
      keptItems: [],
      droppedItems: [{ ...items[0]!, grade: "C", reason: "invalid-grade" }],
    });

    expect(parseSessionSpriteTriage("not json at all", items)).toEqual({
      _tag: "Unparseable",
      excerpt: "not json at all",
    });
  });

  it("即使模型标成 A，确定性二次护栏仍强行降 C（覆盖选甲/正式立项/改 hosts/push 等）", () => {
    const dangerousFills = [
      "选甲继续",
      "就按推荐推进吧",
      "按推荐执行",
      "这个方案可以正式立项",
      "建一个新仓库放脚本",
      "直接推送部署到生产",
      "执行 git push origin main",
      "现在可以改这个配置了",
      "我待会去群里同步",
      "把结论同步进 UC",
      "先修改 hosts 再测",
      "改 hosts 指向测试机",
      "直接删除旧表",
      "准备上线部署",
    ];
    for (const fill of dangerousFills) {
      expect(matchesAuthOrWriteGuard(fill), fill).toBe(true);
      const result = parseSessionSpriteTriage(
        JSON.stringify({ decisions: [{ index: 0, grade: "A", reason: "模型误放行" }] }),
        [{ kind: "next", label: "危险项", fill }],
      );
      expect(result, fill).toEqual({
        _tag: "Parsed",
        keptItems: [],
        droppedItems: [
          {
            kind: "next",
            label: "危险项",
            fill,
            grade: "C",
            reason: "deterministic-auth-guard",
          },
        ],
      });
    }
    expect(matchesAuthOrWriteGuard("请只读核验 diff 外还有哪些调用方受影响，不要改代码。")).toBe(
      false,
    );
  });

  it("formatSpriteDraftMessage 仅在有保留项时生成带非授权协议头的草稿", () => {
    expect(formatSpriteDraftMessage([])).toBeNull();
    const msg = formatSpriteDraftMessage([items[0]!]);
    expect(msg).not.toBeNull();
    expect(msg?.startsWith(SESSION_SPRITE_NON_AUTH_HEADER)).toBe(true);
    expect(msg).toContain("1. 请只读核验 diff 外还有哪些调用方受影响，不要改代码。");
  });
});

describe("JSONL 观察账本读写", () => {
  it.layer(NodeServices.layer)("追加、容错坏行并倒序返回摘要", (it) => {
    it.effect("不存在时返回空，追加与坏行容错一致", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sprite-ledger-" });
        const ledgerPath = path.join(dir, "nested", "cn-session-sprite.jsonl");

        expect(yield* readSessionSpriteLedger(ledgerPath)).toEqual({
          entries: [],
          summary: {
            totalEvaluated: 0,
            wouldAdvance: 0,
            blockedThread: 0,
            blockedItems: 0,
            errors: 0,
            lastScanAt: null,
          },
        });

        const e1 = ledgerEntry({ runId: "run-1", ts: "2026-11-26T10:00:00.000Z" });
        const e2 = ledgerEntry({
          runId: "run-2",
          ts: "2026-11-26T10:10:00.000Z",
          decision: "blocked_thread",
          blockReason: "company_or_blocked_scope",
          keptItems: [],
          draftMessage: null,
        });
        yield* appendSessionSpriteLedgerEntry(ledgerPath, e1);
        yield* fs.writeFileString(ledgerPath, "{corrupted json line\n", { flag: "a" });
        yield* appendSessionSpriteLedgerEntry(ledgerPath, e2);

        const report = yield* readSessionSpriteLedger(ledgerPath, 1);
        expect(report.entries).toEqual([e2]);
        expect(report.summary).toEqual({
          totalEvaluated: 2,
          wouldAdvance: 1,
          blockedThread: 1,
          blockedItems: 0,
          errors: 0,
          lastScanAt: "2026-11-26T10:10:00.000Z",
        });
      }).pipe(Effect.scoped),
    );
  });
});
