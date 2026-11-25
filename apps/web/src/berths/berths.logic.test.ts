import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBerthView,
  emptyBerths,
  enterBerth,
  leaveBerth,
  reconcileBerths,
  type BerthShell,
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
    source: { pendingRuntimeRequest: null },
    createdAt: "2026-11-25T08:00:00.000Z",
    modelSelection: { instanceId: "claude", model: "anthropic/claude-opus-5-5" },
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

const view = (shells: ReadonlyArray<BerthShell>, scheduled: ReadonlyArray<string> = []) =>
  buildBerthView({
    shells,
    environmentId: ENV,
    now: NOW,
    scheduledThreadIds: new Set(scheduled),
  });

const ids = (threads: ReadonlyArray<{ threadId: string }>) => threads.map((t) => t.threadId);

describe("buildBerthView", () => {
  it("keeps only top-level threads in play and drops archived, deleted, settled, snoozed and other environments", () => {
    const result = view([
      shell("live", { branch: "feature" }),
      shell("archived", { archivedAt: "2026-11-24T00:00:00.000Z" }),
      shell("deleted", { deletedAt: "2026-11-24T00:00:00.000Z" }),
      shell("settled", { settledOverride: "settled" }),
      shell("snoozed", { snoozedUntil: "2026-11-26T00:00:00.000Z", snoozedAt: NOW }),
      shell("elsewhere", { environmentId: EnvironmentId.make("environment-b") }),
    ]);
    expect(ids(result.threads)).toEqual(["live"]);
    expect(result.threads[0]).toMatchObject({ model: "claude-opus-5-5", branch: "feature" });
  });

  it("sets scheduled-task threads apart from the main list", () => {
    const result = view([shell("daily"), shell("manual")], ["daily"]);
    expect(ids(result.threads)).toEqual(["manual"]);
    expect(ids(result.scheduled)).toEqual(["daily"]);
  });

  it("files subagents under their listed ancestor in creation order, whatever their status", () => {
    const result = view([
      shell("parent"),
      subagent("late", "parent", { createdAt: "2026-11-25T10:00:00.000Z" }),
      subagent("early", "parent", {
        createdAt: "2026-11-25T09:00:00.000Z",
        hasPendingApprovals: true,
      }),
      subagent("nested", "early", { createdAt: "2026-11-25T11:00:00.000Z" }),
      subagent("gone", "parent", { archivedAt: "2026-11-25T09:30:00.000Z" }),
    ]);
    expect(ids(result.subagents.get("parent") ?? [])).toEqual(["early", "late", "nested"]);
    expect(result.subagents.get("parent")?.[0]?.status).toBe("approval");
    expect(result.threads.map((t) => t.threadId)).toEqual(["parent"]);
  });

  it("survives a subagent cycle and a missing parent", () => {
    const result = view([subagent("a", "b"), subagent("b", "a"), subagent("orphan", "missing")]);
    expect(result.subagents.size).toBe(0);
  });
});

describe("berths", () => {
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

  it("returns the same array when everyone is still in play", () => {
    expect(reconcileBerths(seated, new Set(["a", "b", "c", "e", "other"]))).toBe(seated);
  });

  it("does not seat a new thread by itself", () => {
    expect(reconcileBerths(seated, new Set(["a", "b", "c", "e", "new"]))).toBe(seated);
  });

  it("seats a thread in the first empty berth, or the chosen one, leaving its old berth empty", () => {
    expect(enterBerth(seated, "n")).toEqual(["a", "b", "c", "n", "e", null]);
    expect(enterBerth(seated, "n", 0)).toEqual(["n", "b", "c", null, "e", null]);
    expect(enterBerth(seated, "e", 1)).toEqual(["a", "e", "c", null, null, null]);
  });

  it("changes nothing when every berth is taken and none is chosen", () => {
    const full = ["a", "b", "c", "d", "e", "f"];
    expect(enterBerth(full, "n")).toBe(full);
  });

  it("empties only the chosen berth on leave", () => {
    expect(leaveBerth(seated, 1)).toEqual(["a", null, "c", null, "e", null]);
  });
});

describe("parseBerths", () => {
  const empty = emptyBerths();

  it("reads a saved record back", () => {
    expect(parseBerths(JSON.stringify(["a", null, "b", null, null, "c"]))).toEqual([
      "a",
      null,
      "b",
      null,
      null,
      "c",
    ]);
  });

  it.each([
    null,
    "",
    "{oops",
    "{}",
    JSON.stringify(["a", "b"]),
    JSON.stringify(Array(7).fill(null)),
  ])("reads %j as six empty berths", (raw) => {
    expect(parseBerths(raw)).toEqual(empty);
  });

  it("drops non-string entries and keeps a duplicated thread in its first berth", () => {
    expect(parseBerths(JSON.stringify(["a", 3, "a", "", "b", "a"]))).toEqual([
      "a",
      null,
      null,
      null,
      "b",
      null,
    ]);
  });
});
