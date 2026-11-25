import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBerthView,
  effectiveStatus,
  emptyBerths,
  enterBerth,
  formatSubagentSummary,
  isStrictEtechCandidate,
  leaveBerth,
  rankCandidates,
  reconcileBerths,
  slotCode,
  stripDatePrefix,
  type BerthShell,
  type BerthThread,
} from "./berths.logic";
import { parseBerths } from "./berthsStorage";

const ENV = EnvironmentId.make("environment-a");
const NOW = "2026-11-25T12:00:00.000Z";

function shell(id: string, over: Partial<BerthShell> = {}): BerthShell {
  return {
    environmentId: ENV,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    title: `Thread ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    source: { pendingRuntimeRequest: null, latestVisibleMessage: null },
    createdAt: "2026-11-25T08:00:00.000Z",
    updatedAt: "2026-11-25T08:00:00.000Z",
    branch: null,
    ...over,
  } as BerthShell;
}

const subagent = (id: string, parent: string, over: Partial<BerthShell> = {}) =>
  shell(id, {
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(parent),
    },
    ...over,
  });

const failedRun = (completedAt: string) =>
  ({
    runId: "run-1",
    ordinal: 1,
    status: "failed",
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
    assistantMessageId: null,
  }) as unknown as BerthShell["latestRun"];

const view = (shells: ReadonlyArray<BerthShell>, scheduled: ReadonlyArray<string> = []) =>
  buildBerthView({
    shells,
    environmentId: ENV,
    now: NOW,
    scheduledThreadIds: new Set(scheduled),
  });

const ids = (threads: ReadonlyArray<{ threadId: string }>) => threads.map((t) => t.threadId);

const berthThread = (id: string, over: Partial<BerthThread> = {}): BerthThread => ({
  threadId: id,
  title: `Thread ${id}`,
  displayTitle: `Thread ${id}`,
  status: "done",
  branch: null,
  snippet: null,
  updatedAt: "2026-11-25T08:00:00.000Z",
  createdAt: "2026-11-25T08:00:00.000Z",
  ...over,
});

describe("buildBerthView", () => {
  it("keeps top-level threads in play newest-first and drops archived, deleted, settled, snoozed, sideChat and other environments", () => {
    const result = view([
      shell("older", { updatedAt: "2026-11-25T08:00:00.000Z" }),
      shell("newer", { title: "1125_GWH-350 新任务", updatedAt: "2026-11-25T11:30:00.000Z" }),
      shell("archived", { archivedAt: "2026-11-24T00:00:00.000Z" }),
      shell("deleted", { deletedAt: "2026-11-24T00:00:00.000Z" }),
      shell("settled", { settledOverride: "settled" }),
      shell("snoozed", { snoozedUntil: "2026-11-26T00:00:00.000Z", snoozedAt: NOW }),
      shell("side", {
        lineage: {
          parentThreadId: ThreadId.make("newer"),
          relationshipToParent: null,
          rootThreadId: ThreadId.make("newer"),
          sideChat: true,
        },
      }),
      shell("elsewhere", { environmentId: EnvironmentId.make("environment-b") }),
    ]);
    expect(ids(result.threads)).toEqual(["newer", "older"]);
    expect(result.threads[0]?.displayTitle).toBe("GWH-350 新任务");
  });

  it("sets scheduled-task threads apart from the main list", () => {
    const result = view([shell("daily"), shell("manual")], ["daily"]);
    expect(ids(result.threads)).toEqual(["manual"]);
    expect(ids(result.scheduled)).toEqual(["daily"]);
  });

  it("surfaces live subagents and recent unseen failed subagents, while suppressing done, seen, superseded, and >24h stale failures", () => {
    const parent = shell("parent", {
      latestUserAuthoredMessageAt: "2026-11-25T10:00:00.000Z",
    });
    const result = view([
      parent,
      subagent("live-approval", "parent", { hasPendingApprovals: true }),
      subagent("done-old", "parent"),
      subagent("failed-recent", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-25T11:00:00.000Z"),
      }),
      subagent("failed-seen", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-25T11:00:00.000Z"),
        lastVisitedAt: "2026-11-25T11:30:00.000Z",
      }),
      subagent("failed-earlier-turn", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-25T09:00:00.000Z"),
      }),
      subagent("failed-3days-ago", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-22T10:00:00.000Z"),
      }),
      subagent("nested-working", "live-approval", {
        runtime: { status: "running" } as BerthShell["runtime"],
      }),
    ]);
    expect(ids(result.subagents.get("parent") ?? [])).toEqual([
      "live-approval",
      "failed-recent",
      "nested-working",
    ]);
  });

  it("suppresses >24h stale subagent failure even when parent has no user message timestamp", () => {
    const result = view([
      shell("parent"),
      subagent("stale", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-24T11:00:00.000Z"),
      }),
      subagent("fresh", "parent", {
        runtime: { status: "failed" } as BerthShell["runtime"],
        latestRun: failedRun("2026-11-25T06:00:00.000Z"),
      }),
    ]);
    expect(ids(result.subagents.get("parent") ?? [])).toEqual(["fresh"]);
  });

  it("survives a subagent cycle and a missing parent", () => {
    const result = view([
      subagent("a", "b", { hasPendingApprovals: true }),
      subagent("b", "a", { hasPendingApprovals: true }),
      subagent("orphan", "missing", { hasPendingApprovals: true }),
    ]);
    expect(result.subagents.size).toBe(0);
  });
});

describe("strict etech hint, formatting and ranking", () => {
  it("matches strict company tickets and CVS/TET/SIR without false positives on work, 141 or etech infra", () => {
    expect(
      isStrictEtechCandidate(berthThread("1", { title: "1125_GWH-350 work TET SIR#91" })),
    ).toBe(true);
    expect(isStrictEtechCandidate(berthThread("2", { title: "本机手动提交 CVS 流程优化" }))).toBe(
      true,
    );
    expect(
      isStrictEtechCandidate(berthThread("3", { title: "修复", branch: "fix/NSNET-108" })),
    ).toBe(true);
    expect(
      isStrictEtechCandidate(
        berthThread("4", { title: "1125_universe M3台式机141与etech镜像仓连携分析" }),
      ),
    ).toBe(false);
    expect(isStrictEtechCandidate(berthThread("5", { title: "work on PR 141" }))).toBe(false);
  });

  it("strips leading MMDD_ date prefix cleanly and formats slot codes and subagent summaries", () => {
    expect(stripDatePrefix("1125_GWH-350 SIR#91")).toBe("GWH-350 SIR#91");
    expect(stripDatePrefix("1125_")).toBe("1125_");
    expect([0, 1, 2, 3, 4, 5].map(slotCode)).toEqual(["E1", "E2", "03", "04", "05", "06"]);
    expect(
      formatSubagentSummary([
        berthThread("s1", { status: "failed" }),
        berthThread("s2", { status: "approval" }),
        berthThread("s3", { status: "working" }),
      ]),
    ).toBe("3 子代理 · 1 失败 · 1 待处理 · 1 运行");
    expect(formatSubagentSummary([])).toBeNull();
  });

  it("ranks strict etech candidates first for E1/E2 and urgent + newest first otherwise", () => {
    const oldPersonal = berthThread("p1", {
      title: "旧线程",
      updatedAt: "2026-11-24T08:00:00.000Z",
    });
    const newPersonal = berthThread("p2", {
      title: "新线程",
      status: "input",
      updatedAt: "2026-11-25T11:00:00.000Z",
    });
    const etechQuiet = berthThread("e1", {
      title: "1125_GWH-350 票",
      updatedAt: "2026-11-25T09:00:00.000Z",
    });
    expect(ids(rankCandidates([oldPersonal, newPersonal, etechQuiet], new Map(), true))).toEqual([
      "e1",
      "p2",
      "p1",
    ]);
    expect(ids(rankCandidates([oldPersonal, newPersonal, etechQuiet], new Map(), false))).toEqual([
      "p2",
      "e1",
      "p1",
    ]);
    expect(effectiveStatus(oldPersonal, [berthThread("s1", { status: "failed" })])).toBe("failed");
  });
});

describe("fixed berths", () => {
  const seated = ["a", "b", "c", null, "e", null];

  it("empties the berth of a thread no longer in play without shifting any other", () => {
    expect(reconcileBerths(seated, new Set(["a", "c", "e"]))).toEqual([
      "a",
      null,
      "c",
      null,
      "e",
      null,
    ]);
  });

  it("seats a thread in the chosen slot and leaves its previous slot empty", () => {
    expect(enterBerth(seated, "e", 0)).toEqual(["e", "b", "c", null, null, null]);
    expect(leaveBerth(seated, 1)).toEqual(["a", null, "c", null, "e", null]);
  });

  it("parses storage safely", () => {
    expect(parseBerths(JSON.stringify(["a", 3, "a", "", "b", "a"]))).toEqual([
      "a",
      null,
      null,
      null,
      "b",
      null,
    ]);
    expect(parseBerths("{oops")).toEqual(emptyBerths());
  });
});
