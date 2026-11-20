import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortFolderThreadsByStatus } from "./folderStatusOrder-cn";

const base = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestRun: {
    runId: "turn-1" as never,
    status: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  },
  lastVisitedAt: "2026-03-09T10:06:00.000Z",
  runtime: null,
  title: "",
};
const runtime = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-03-09T10:00:00.000Z",
};
const named = (id: string, overrides: object) => ({ ...base, ...overrides, id });

describe("sortFolderThreadsByStatus", () => {
  const working = named("working", { runtime });
  const waiting = named("waiting", { runtime: { ...runtime, status: "idle" as const } });
  const done = named("done", {});
  const unseen = named("unseen", { lastVisitedAt: "2026-03-09T10:04:00.000Z" });
  const failed = named("failed", { runtime: { ...runtime, status: "failed" as const } });
  const attention = named("attention", { hasPendingUserInput: true });

  it("orders attention, failed, unseen, done, waiting, working", () => {
    const sorted = sortFolderThreadsByStatus([working, waiting, done, unseen, failed, attention]);
    expect(sorted.map((thread) => thread.id)).toEqual([
      "attention",
      "failed",
      "unseen",
      "done",
      "waiting",
      "working",
    ]);
  });

  it("keeps incoming order within a tier and handles an empty list", () => {
    const secondWorking = named("working-2", { runtime });
    expect(
      sortFolderThreadsByStatus([working, done, secondWorking]).map((thread) => thread.id),
    ).toEqual(["done", "working", "working-2"]);
    expect(sortFolderThreadsByStatus([])).toEqual([]);
  });

  it("orders a tier by MMDD_ title, newest day first, then the rest; undated last", () => {
    const titled = (id: string) => named(id, { title: id });
    const sorted = sortFolderThreadsByStatus(
      [
        titled("新会话"),
        titled("1114_haken 用量"),
        named("plain", {}),
        titled("1115_universe 规则"),
        titled("1115_glgs-poc 提交"),
        named("failed", { title: "0101_x", runtime: { ...runtime, status: "failed" as const } }),
      ],
      new Date(2026, 10, 15),
    );
    expect(sorted.map((thread) => thread.id)).toEqual([
      "failed",
      "1115_glgs-poc 提交",
      "1115_universe 规则",
      "1114_haken 用量",
      "新会话",
      "plain",
    ]);
  });

  it("treats a day after today as last year", () => {
    const titled = (id: string) => named(id, { title: id });
    const sorted = sortFolderThreadsByStatus(
      [titled("1231_old"), titled("0102_new"), titled("0101_mid")],
      new Date(2027, 0, 2),
    );
    expect(sorted.map((thread) => thread.id)).toEqual(["0102_new", "0101_mid", "1231_old"]);
  });
});
