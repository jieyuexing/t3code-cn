// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { discoverRepos, readLog } from "./gitFacts.ts";

const T0 = 1_800_000_000;

function makeRepo(path: string) {
  NodeFS.mkdirSync(path, { recursive: true });
  const git = (args: ReadonlyArray<string>, at = T0) =>
    NodeChildProcess.execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_AUTHOR_NAME: "作者",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "作者",
        GIT_COMMITTER_EMAIL: "a@example.com",
        GIT_AUTHOR_DATE: `@${at} +0000`,
        GIT_COMMITTER_DATE: `@${at} +0000`,
      },
    }).trim();
  git(["init", "-q", "-b", "main"]);
  const commit = (file: string, message: string, at: number) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(path, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(path, file), `${message}\n`);
    git(["add", "-A"], at);
    git(["commit", "-q", "-m", message], at);
  };
  return { path, git, commit };
}

describe("git log", () => {
  it("discovers nested repos in project order and skips noise directories", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-log-"));
    makeRepo(root);
    makeRepo(NodePath.join(root, "projects", "beta"));
    makeRepo(NodePath.join(root, "projects", "alpha"));
    makeRepo(NodePath.join(root, "node_modules", "ignored"));
    makeRepo(NodePath.join(root, ".local", "ignored"));
    try {
      expect(discoverRepos([root])).toEqual([
        { path: root, name: NodePath.basename(root) },
        { path: NodePath.join(root, "projects", "alpha"), name: "projects/alpha" },
        { path: NodePath.join(root, "projects", "beta"), name: "projects/beta" },
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads topological history with parents and refs, pages by limit, and filters", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-log-"));
    const repo = makeRepo(NodePath.join(root, "r"));
    try {
      repo.commit("one.txt", "a1", T0 + 10);
      repo.git(["tag", "v1"], T0 + 10);
      repo.git(["checkout", "-q", "-b", "topic"], T0 + 20);
      repo.commit("docs/guide.md", "topic work", T0 + 30);
      repo.git(["checkout", "-q", "main"], T0 + 40);
      repo.commit("two.txt", "a2", T0 + 40);
      repo.git(["merge", "-q", "--no-ff", "topic", "-m", "merge topic"], T0 + 50);

      const all = await readLog(repo.path, { limit: 10, query: "" });
      expect(all.hasMore).toBe(false);
      const subjects = all.commits.map((c) => c.subject);
      expect([subjects[0], subjects[3]]).toEqual(["merge topic", "a1"]);
      expect(new Set(subjects)).toEqual(new Set(["merge topic", "a2", "topic work", "a1"]));
      expect(all.commits[0]?.parents).toHaveLength(2);
      expect(all.commits[0]?.refs).toEqual(["main"]);
      expect(all.commits[3]?.refs).toEqual(["v1"]);
      expect(all.commits[3]?.parents).toEqual([]);
      expect(all.commits[1]?.author).toBe("作者");
      expect(all.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);

      const page = await readLog(repo.path, { limit: 2, query: "" });
      expect(page.commits.map((c) => c.subject)).toEqual(subjects.slice(0, 2));
      expect(page.hasMore).toBe(true);

      expect(
        (await readLog(repo.path, { limit: 10, query: "TOPIC" })).commits.map((c) => c.subject),
      ).toEqual(["merge topic", "topic work"]);
      expect((await readLog(repo.path, { limit: 10, query: "作者" })).commits).toHaveLength(4);
      expect(
        (await readLog(repo.path, { limit: 10, query: "GUIDE.md" })).commits.map((c) => c.subject),
      ).toEqual(["topic work"]);
      expect((await readLog(repo.path, { limit: 10, query: "[*" })).commits).toEqual([]);
      const filteredPage = await readLog(repo.path, { limit: 1, query: "topic" });
      expect([filteredPage.commits.length, filteredPage.hasMore]).toEqual([1, true]);

      const empty = makeRepo(NodePath.join(root, "empty"));
      expect(await readLog(empty.path, { limit: 10, query: "" })).toEqual({
        commits: [],
        hasMore: false,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
