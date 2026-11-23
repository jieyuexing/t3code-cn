import type { NeedsYouDueItem, NeedsYouGtd } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatDaysLeft,
  gtdSummary,
  orphanStats,
  threadIdOfSource,
  wakeGroups,
} from "./needsYouGtd.logic";

const due = (date: string, daysLeft: number, file = "a.md", line = 1): NeedsYouDueItem => ({
  file,
  line,
  date,
  daysLeft,
  section: "节",
  excerpt: "摘要",
});

const gtd = (over: Partial<NeedsYouGtd> = {}): NeedsYouGtd => ({
  available: true,
  overdue: [],
  upcoming: [],
  topics: [],
  orphans: [],
  recentLinkedCount: 0,
  privateCount: 0,
  reposScanned: 0,
  errors: [],
  scannedAt: "2026-11-23T00:00:00.000Z",
  ...over,
});

describe("threadIdOfSource", () => {
  const id = "2756bac6-cb25-46d8-9777-39732a4d3973";
  it("takes the id from a thread link, a bare id or text that carries one", () => {
    expect(threadIdOfSource(`t3-thread://${id}`)).toBe(id);
    expect(threadIdOfSource(`t3-thread://env-1/${id.toUpperCase()}`)).toBe(id);
    expect(threadIdOfSource(`t3-thread://v2/1d9b2f9b-9d6b-4ccd-8016-3dee44377a6f/${id}`)).toBe(id);
    expect(threadIdOfSource(id)).toBe(id);
    expect(threadIdOfSource(`1114_Primeagen 状态机帖（${id}）`)).toBe(id);
  });

  it("gives nothing for plain text and launch links", () => {
    expect(threadIdOfSource("1113_gofcatweb 提交流程变慢原因（M3）")).toBeNull();
    expect(threadIdOfSource("t3-thread://mcp:launch:809a8f6a728157a5d69b3b0b1b81ed2c")).toBeNull();
    expect(threadIdOfSource("")).toBeNull();
  });
});

describe("wakeGroups", () => {
  it("orders overdue and upcoming items by date, then file and line", () => {
    const groups = wakeGroups(
      gtd({
        overdue: [
          due("2026-11-22", -1),
          due("2026-11-18", -5, "b.md", 9),
          due("2026-11-18", -5, "b.md", 2),
        ],
        upcoming: [due("2026-12-01", 8), due("2026-11-25", 2)],
      }),
    );
    expect(groups.overdue.map((item) => `${item.date}:${item.line}`)).toEqual([
      "2026-11-18:2",
      "2026-11-18:9",
      "2026-11-22:1",
    ]);
    expect(groups.upcoming.map((item) => item.date)).toEqual(["2026-11-25", "2026-12-01"]);
  });
});

describe("gtdSummary", () => {
  it("counts wake items, soon items and the inbox", () => {
    const summary = gtdSummary(
      gtd({
        overdue: [due("2026-11-20", -3)],
        upcoming: [due("2026-11-26", 3), due("2026-11-27", 4)],
        topics: [{ topic: "t", thread: "", capturedAt: "", status: "pending" }],
        orphans: [
          { date: "2026-11-23", repo: "r", file: "f", subject: "s" },
          { date: "2026-11-23", repo: "r", file: "g", subject: "s" },
        ],
      }),
    );
    expect(summary).toEqual({ wake: 3, soon: 2, inbox: 3 });
  });

  it("is all zero when nothing came back", () => {
    expect(gtdSummary(gtd())).toEqual({ wake: 0, soon: 0, inbox: 0 });
  });
});

it("words the days left and the scan line", () => {
  expect([-3, 0, 1, 7].map(formatDaysLeft)).toEqual(["逾期 3 天", "今天", "明天", "7 天后"]);
  expect(orphanStats(gtd({ reposScanned: 39, recentLinkedCount: 3, privateCount: 9 }))).toBe(
    "扫 39 仓 · 已挂入口 3 · 隐私省略 9",
  );
});
