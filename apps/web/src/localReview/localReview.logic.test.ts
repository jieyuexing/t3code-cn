import type {
  LocalReviewCommit,
  LocalReviewFile,
  LocalReviewRequestHead,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commitsOfRepo,
  describeFileState,
  fileDiffTargets,
  formatRequestTime,
  groupFilesByRepo,
  groupRequestsByThread,
  requestHeadline,
  sourceLabel,
} from "./localReview.logic";

const file = (overrides: Partial<LocalReviewFile>): LocalReviewFile => ({
  repo: "/u/a",
  path: "x.ts",
  sources: ["output"],
  commits: [],
  state: { kind: "unknown" },
  ...overrides,
});

const commit = (hash: string, time: number, repo = "/u/a"): LocalReviewCommit => ({
  repo,
  hash,
  subject: `subject ${hash}`,
  time,
  role: "output",
  orphan: false,
  mergedAs: null,
  mergedVia: null,
  alsoIn: [],
  fromChild: false,
});

describe("localReview.logic", () => {
  it("groups files by repo name and sorts paths", () => {
    const groups = groupFilesByRepo([
      file({ repo: "/u/z-repo", path: "b.ts" }),
      file({ repo: "/u/a-repo", path: "b.ts" }),
      file({ repo: "/u/a-repo", path: "a.ts" }),
    ]);
    expect(groups.map((g) => [g.name, g.files.map((f) => f.path)])).toEqual([
      ["a-repo", ["a.ts", "b.ts"]],
      ["z-repo", ["b.ts"]],
    ]);
  });

  it("lists each commit oldest first, then the uncommitted state", () => {
    const targets = fileDiffTargets(file({ commits: ["b", "a"], state: { kind: "uncommitted" } }), [
      commit("a", 1),
      commit("b", 2),
      commit("c", 3),
    ]);
    expect(targets.map((t) => (t.kind === "commit" ? t.hash : t.kind))).toEqual([
      "a",
      "b",
      "working-tree",
    ]);
    expect(fileDiffTargets(file({}), [])).toEqual([]);
  });

  it("describes state and sources and picks a repo's commits in time order", () => {
    expect(describeFileState(file({ state: { kind: "uncommitted" } }))).toBe("现仍未提交");
    expect(describeFileState(file({ state: { kind: "committed", hash: "1234567890" } }))).toBe(
      "现已提交到 1234567",
    );
    expect(describeFileState(file({}))).toBeNull();
    expect(sourceLabel("checkpoint")).toBe("总仓快照");
    expect(sourceLabel("fileChange")).toBe("编辑记录");
    expect(sourceLabel("output")).toBe("本次提交");
    expect(
      commitsOfRepo([commit("b", 2), commit("a", 1), commit("z", 0, "/u/other")], "/u/a").map(
        (c) => c.hash,
      ),
    ).toEqual(["a", "b"]);
  });

  it("groups requests by thread, newest first, and writes headlines", () => {
    const head = (
      requestId: string,
      threadId: string,
      startedAt: string,
      requestTitle: string,
      origin: "user" | "agent" = "user",
    ): LocalReviewRequestHead =>
      ({
        requestId,
        threadId,
        threadTitle: `线程 ${threadId}`,
        requestTitle,
        startedAt,
        endedAt: startedAt,
        runCount: 1,
        origin,
        childCount: 0,
        fileChangeCount: 1,
        commitCommandCount: 0,
      }) as LocalReviewRequestHead;
    const groups = groupRequestsByThread([
      head("a1", "A", "2027-01-15T01:00:00.000Z", "早"),
      head("b1", "B", "2027-01-15T05:00:00.000Z", "乙"),
      head("a2", "A", "2027-01-15T07:00:00.000Z", "晚"),
    ]);
    expect(groups.map((g) => [g.threadId, g.requests.map((r) => r.requestId)])).toEqual([
      ["A", ["a2", "a1"]],
      ["B", ["b1"]],
    ]);
    expect(requestHeadline(head("x", "A", "2027-01-15T01:00:00.000Z", "做点事", "agent"))).toBe(
      "Agent 发起 · 做点事",
    );
    expect(requestHeadline(head("x", "A", "2027-01-15T01:00:00.000Z", ""))).toBe(
      "（没有文字的请求）",
    );
    expect(formatRequestTime("2027-01-15T01:07:00.000Z")).toMatch(/^\d\d-\d\d \d\d:07$/);
  });
});
