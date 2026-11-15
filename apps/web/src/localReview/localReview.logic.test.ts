import type { LocalReviewCommit, LocalReviewFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commitsOfRepo,
  describeFileState,
  describeSources,
  fileDiffTargets,
  groupFilesByRepo,
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
    expect(describeSources(file({ sources: ["checkpoint", "child"] }))).toBe("检查点、子会话");
    expect(
      commitsOfRepo([commit("b", 2), commit("a", 1), commit("z", 0, "/u/other")], "/u/a").map(
        (c) => c.hash,
      ),
    ).toEqual(["a", "b"]);
  });
});
