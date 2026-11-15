import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { PendingThreadShell } from "../pendingThreads";
import {
  buildEntries,
  formatWait,
  missingTextJobs,
  needsYouThreads,
  tomorrowMorning,
  type NeedsYouThread,
} from "./needsYou.logic";

const ENV = EnvironmentId.make("environment-a");
const NOW = Date.parse("2026-11-11T12:00:00.000Z");

const thread = (id: string, over: Partial<NeedsYouThread> = {}): NeedsYouThread => ({
  threadId: id,
  title: `Thread ${id}`,
  status: "done",
  request: null,
  requestId: null,
  lastTurnCompletedAt: "2026-11-11T10:00:00.000Z",
  waitingSince: "2026-11-11T10:00:00.000Z",
  ...over,
});

const shell = (id: string, over: Partial<PendingThreadShell> = {}): PendingThreadShell => ({
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
});

describe("needsYouThreads", () => {
  it("carries the open request's id and leaves out threads that are working", () => {
    const asking = shell("asking", {
      hasPendingApprovals: true,
      source: {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "command",
          createdAt: DateTime.makeUnsafe("2026-11-11T09:00:00.000Z"),
        },
      },
    });
    const working = shell("working", {
      runtime: { status: "running" } as PendingThreadShell["runtime"],
    });
    const listed = needsYouThreads({
      shells: [asking, working, shell("plain")],
      environmentId: ENV,
      now: "2026-11-11T12:00:00.000Z",
    });
    expect(listed.map((entry) => [entry.threadId, entry.status, entry.requestId])).toEqual([
      ["asking", "approval", "request-1"],
      ["plain", "done", null],
    ]);
  });
});

describe("buildEntries", () => {
  it("lists native states and replies with a decision, longest wait first, unknown start last", () => {
    const texts = { "reply:done@2026-11-11T10:00:00.000Z": "合并吗？" };
    const entries = buildEntries(
      [
        thread("unknown", { status: "failed", waitingSince: null }),
        thread("done", { waitingSince: "2026-11-11T10:00:00.000Z" }),
        thread("approve", { status: "approval", waitingSince: "2026-11-11T09:00:00.000Z" }),
        thread("plain", { lastTurnCompletedAt: "2026-11-11T08:00:00.000Z" }),
        thread("guest", { status: "request", waitingSince: "2026-11-10T09:00:00.000Z" }),
      ],
      { ...texts, "reply:plain@2026-11-11T08:00:00.000Z": "" },
    );
    expect(entries.map((entry) => [entry.thread.threadId, entry.kind, entry.text])).toEqual([
      ["guest", "request", "等待回应"],
      ["approve", "approval", "等待审批"],
      ["done", "reply", "合并吗？"],
      ["unknown", "failed", "失败"],
    ]);
  });

  it("shows a question's first line once read, and a placeholder until then", () => {
    const asked = thread("asked", {
      status: "input",
      request: { kind: "user_input", createdAt: "2026-11-11T09:00:00.000Z" },
    });
    expect(buildEntries([asked], {})[0]?.text).toBe("等待输入");
    expect(
      buildEntries([asked], { "question:asked@2026-11-11T09:00:00.000Z": "选哪个库？" })[0]?.text,
    ).toBe("选哪个库？");
  });
});

describe("missingTextJobs", () => {
  it("reads replies of finished or waiting threads and questions of asking ones, once per turn", () => {
    const threads = [
      thread("done"),
      thread("waiting", { status: "waiting" }),
      thread("asked", { status: "input", request: { kind: "user_input", createdAt: "t1" } }),
      thread("failed", { status: "failed" }),
      thread("approve", { status: "approval" }),
    ];
    const jobs = missingTextJobs(threads, {});
    expect(jobs.map((job) => [job.threadId, job.source])).toEqual([
      ["done", "reply"],
      ["waiting", "reply"],
      ["asked", "question"],
    ]);
    expect(missingTextJobs(threads, Object.fromEntries(jobs.map((job) => [job.key, ""])))).toEqual(
      [],
    );
    expect(
      missingTextJobs([thread("done", { lastTurnCompletedAt: "2026-11-11T11:30:00.000Z" })], {
        [jobs[0]!.key]: "",
      }),
    ).toHaveLength(1);
  });
});

describe("time", () => {
  it.each([
    ["2026-11-11T11:59:40.000Z", "刚刚"],
    ["2026-11-11T11:35:00.000Z", "25 分"],
    ["2026-11-11T09:00:00.000Z", "3 小时"],
    ["2026-11-11T10:20:00.000Z", "1 小时 40 分"],
    ["2026-11-09T09:00:00.000Z", "2 天 3 小时"],
    ["2026-11-09T12:00:00.000Z", "2 天"],
  ])("%s → %s", (since, label) => {
    expect(formatWait(since, NOW)).toBe(label);
  });

  it("snoozes to 09:00 local the next day, across a month end too", () => {
    const next = tomorrowMorning(new Date(2026, 10, 30, 23, 59));
    expect([
      next.getFullYear(),
      next.getMonth(),
      next.getDate(),
      next.getHours(),
      next.getMinutes(),
    ]).toEqual([2026, 11, 1, 9, 0]);
  });
});
