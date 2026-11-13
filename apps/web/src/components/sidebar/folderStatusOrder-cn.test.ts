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
});
