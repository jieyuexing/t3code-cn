import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { clipReply, pendingThreads, type PendingThreadShell } from "./pendingThreads";

const ENV = EnvironmentId.make("environment-a");
const NOW = "2026-11-11T12:00:00.000Z";
const PROJECTS = new Map([[ProjectId.make("project-a"), "Alpha project"]]);

function shell(id: string, over: Partial<PendingThreadShell> = {}): PendingThreadShell {
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
    ...over,
  };
}

const run = (completedAt: string | null) =>
  ({ latestRun: { completedAt } }) as Pick<PendingThreadShell, "latestRun">;

const pending = (shells: ReadonlyArray<PendingThreadShell>, environmentId = ENV) =>
  pendingThreads({ shells, environmentId, projectNames: PROJECTS, now: NOW });

describe("pendingThreads", () => {
  it("leaves out subagents, side chats, archived, settled, snoozed and other environments' threads", () => {
    const listed = shell("listed");
    const result = pending([
      listed,
      shell("sub", {
        lineage: {
          parentThreadId: listed.id,
          relationshipToParent: "subagent",
          rootThreadId: listed.id,
        },
      }),
      shell("side", {
        lineage: {
          parentThreadId: listed.id,
          relationshipToParent: null,
          rootThreadId: listed.id,
          sideChat: true,
        },
      }),
      shell("archived", { archivedAt: "2026-11-10T00:00:00.000Z" }),
      shell("settled", { settledOverride: "settled" }),
      shell("snoozed", { snoozedUntil: "2026-11-12T00:00:00.000Z", snoozedAt: NOW }),
      shell("elsewhere", { environmentId: EnvironmentId.make("environment-b") }),
    ]);
    expect(result.map((thread) => thread.threadId)).toEqual(["listed"]);
  });

  it("lists a snoozed thread again once its snooze ran out or a request woke it", () => {
    const result = pending([
      shell("expired", {
        snoozedUntil: "2026-11-11T11:00:00.000Z",
        snoozedAt: "2026-11-11T08:00:00.000Z",
      }),
      shell("approval", {
        snoozedUntil: "2026-11-12T00:00:00.000Z",
        snoozedAt: NOW,
        hasPendingApprovals: true,
      }),
    ]);
    expect(result.map((thread) => thread.threadId)).toEqual(["expired", "approval"]);
  });

  it("starts waiting at the open request, else at the last finished turn", () => {
    const asked = shell("asked", {
      hasPendingUserInput: true,
      ...run("2026-11-11T01:00:00.000Z"),
      source: {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe("2026-11-11T09:30:00.000Z"),
        },
      },
    });
    const done = shell("done", run("2026-11-11T02:00:00.000Z"));
    const fresh = shell("fresh");
    // Marked as asking by the shell's own timestamp when no request summary came with it.
    const stamped = shell("stamped", {
      hasPendingUserInput: true,
      pendingUserInputAt: "2026-11-11T05:00:00.000Z",
      ...run("2026-11-11T04:00:00.000Z"),
    });
    const [askedRow, doneRow, freshRow, stampedRow] = pending([asked, done, fresh, stamped]);
    expect(stampedRow).toMatchObject({ status: "input", waitingSince: "2026-11-11T05:00:00.000Z" });
    expect(askedRow).toMatchObject({
      status: "input",
      project: "Alpha project",
      request: { kind: "user_input", createdAt: "2026-11-11T09:30:00.000Z" },
      lastTurnCompletedAt: "2026-11-11T01:00:00.000Z",
      waitingSince: "2026-11-11T09:30:00.000Z",
    });
    expect(doneRow).toMatchObject({
      status: "done",
      request: null,
      waitingSince: "2026-11-11T02:00:00.000Z",
    });
    expect(freshRow).toMatchObject({ waitingSince: null, lastTurnCompletedAt: null });
  });

  it("classifies like the sidebar", () => {
    const status = (over: Partial<PendingThreadShell>) => pending([shell("t", over)])[0]?.status;
    expect(status({ hasPendingApprovals: true })).toBe("approval");
    expect(status({ pendingGuestMessageCount: 1 })).toBe("request");
    expect(
      status({
        runtime: { status: "failed", lastErrorClass: null } as PendingThreadShell["runtime"],
      }),
    ).toBe("failed");
    expect(status({ runtime: { status: "running" } as PendingThreadShell["runtime"] })).toBe(
      "working",
    );
    expect(status({ runtime: { status: "idle" } as PendingThreadShell["runtime"] })).toBe(
      "waiting",
    );
  });
});

describe("clipReply", () => {
  it("keeps a short reply whole", () => {
    expect(clipReply("done")).toEqual({ text: "done", truncated: false });
  });

  it("keeps the last 60000 characters of a long reply, where it asks, and says so", () => {
    const clipped = clipReply(`头${"字".repeat(60_000)}尾`);
    expect(clipped.text).toHaveLength(60_000);
    expect(clipped.text.endsWith("字尾")).toBe(true);
    expect(clipped.truncated).toBe(true);
  });

  it("cuts further when escaping would push the message past the bridge limit", () => {
    const clipped = clipReply(`头${"\n".repeat(60_000)}尾`);
    expect(JSON.stringify(clipped.text).length).toBeLessThanOrEqual(64_000);
    expect(clipped.text.endsWith("尾")).toBe(true);
    expect(clipped.truncated).toBe(true);
  });
});
