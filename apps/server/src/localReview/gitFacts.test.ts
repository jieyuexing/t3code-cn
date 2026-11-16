// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createGitHistory, discoverRepos } from "./gitFacts.ts";

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
    NodeFS.writeFileSync(NodePath.join(path, file), `${message}\n`);
    git(["add", "-A"], at);
    git(["commit", "-q", "-m", message], at);
    return git(["rev-parse", "HEAD"], at);
  };
  return { path, git, commit };
}

describe("local review git history", () => {
  it("discovers nested repos by relative name and skips noise directories", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-review-"));
    makeRepo(root);
    makeRepo(NodePath.join(root, "projects", "alpha"));
    makeRepo(NodePath.join(root, "node_modules", "ignored"));
    makeRepo(NodePath.join(root, ".local", "ignored"));
    try {
      expect(discoverRepos([root])).toEqual([
        { path: root, name: NodePath.basename(root) },
        { path: NodePath.join(root, "projects", "alpha"), name: "projects/alpha" },
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges HEAD history across repos newest first and reports dirty files and more pages", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-review-"));
    const a = makeRepo(NodePath.join(root, "a"));
    const b = makeRepo(NodePath.join(root, "b"));
    const empty = makeRepo(NodePath.join(root, "empty"));
    try {
      a.commit("one.txt", "a1", T0 + 10);
      a.git(["tag", "v1"], T0 + 10);
      b.commit("one.txt", "b1\n\n正文第二段", T0 + 20);
      a.git(["checkout", "-q", "-b", "topic"], T0 + 30);
      a.commit("two.txt", "a-topic", T0 + 30);
      a.git(["checkout", "-q", "main"], T0 + 40);
      a.commit("three.txt", "a2", T0 + 40);
      a.git(["merge", "-q", "--no-ff", "topic", "-m", "merge topic"], T0 + 50);
      NodeFS.writeFileSync(NodePath.join(b.path, "dirty.txt"), "x");
      NodeFS.writeFileSync(NodePath.join(b.path, "one.txt"), "changed");

      const history = createGitHistory();
      const repos = discoverRepos([root]);
      const all = await history.commits(repos, 3);
      expect(all.commits.map((c) => c.subject)).toEqual(["merge topic", "a2", "a-topic"]);
      expect(all.hasMore).toBe(true);
      expect(all.commits[0]?.parents).toHaveLength(2);
      expect(all.commits[0]?.refs).toEqual(["main"]);
      expect(await history.dirty(repos)).toEqual([{ repo: b.path, changeCount: 2 }]);

      const everything = await history.commits(repos, 10);
      expect(everything.hasMore).toBe(false);
      const b1 = everything.commits.find((c) => c.subject === "b1");
      expect(b1?.message).toBe("b1\n\n正文第二段");
      expect(b1?.author).toBe("作者");
      expect(b1?.repo).toBe(b.path);
      expect(everything.commits.find((c) => c.subject === "a1")?.refs).toEqual(["v1"]);

      const single = repos.filter((r) => r.path === empty.path);
      expect(await history.commits(single, 10)).toEqual({ commits: [], hasMore: false });
      expect(await history.dirty(single)).toEqual([]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
