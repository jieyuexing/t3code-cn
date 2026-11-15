// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { attributeRequest } from "./attribution.ts";
import { createGitFacts } from "./gitFacts.ts";
import type { Request, Snapshot, SnapshotCommand } from "./types.ts";

const T0 = 1_800_000_000;

function setup() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "local-review-"));
  const repo = NodePath.join(base, "repo");
  NodeFS.mkdirSync(repo);
  const git = (args: ReadonlyArray<string>, at: number) =>
    NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: `@${at} +0000`,
        GIT_COMMITTER_DATE: `@${at} +0000`,
      },
    }).trim();
  git(["init", "-q", "-b", "main"], T0 - 100);
  const write = (name: string, body: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, name), body);
  };
  const commit = (message: string, at: number) => {
    git(["add", "-A"], at);
    git(["commit", "-q", "-m", message], at);
    return git(["rev-parse", "HEAD"], at);
  };
  return {
    repo,
    git,
    write,
    commit,
    facts: createGitFacts({ scanRoot: base, home: base }),
    cleanup: () => NodeFS.rmSync(base, { recursive: true, force: true }),
  };
}

const request: Request = {
  id: "T:1",
  threadId: "T",
  runIds: ["T:1"],
  origin: "user",
  startedAt: T0 * 1000,
  endedAt: (T0 + 60) * 1000,
  running: false,
};

const command = (input: string, output: string, startSec: number): SnapshotCommand => ({
  threadId: "T",
  runId: "T:1",
  startedAt: (T0 + startSec) * 1000,
  completedAt: (T0 + startSec + 2) * 1000,
  input,
  output,
});

const snapshot = (
  cwd: string,
  commands: ReadonlyArray<SnapshotCommand>,
  fileChanges: Snapshot["fileChanges"] = [],
): Snapshot => ({
  runs: [],
  threads: [{ threadId: "T", cwd }],
  subagents: [],
  commands,
  fileChanges,
  checkpoints: [],
});

describe("attributeRequest with real git", () => {
  it("finds root commits, silent commits and first-parent files of a merge", async () => {
    const s = setup();
    try {
      s.write("a.txt", "1");
      s.commit("init", T0 + 1);
      s.git(["checkout", "-q", "-b", "side"], T0 + 9);
      s.write("side.txt", "s");
      s.commit("side work", T0 + 10);
      s.git(["checkout", "-q", "main"], T0 + 11);
      s.write("main.txt", "m");
      s.commit("main work", T0 + 15);
      s.git(["merge", "--no-ff", "-q", "-m", "merge side", "side"], T0 + 30);
      const result = await attributeRequest(
        snapshot(s.repo, [
          command(`git -C ${s.repo} commit -q -m init`, "", 0),
          command(`git -C ${s.repo} merge side`, "Merge made by the 'ort' strategy.", 29),
        ]),
        request,
        s.facts,
      );
      expect(result.commits.map((c) => c.subject).toSorted()).toEqual(["init", "merge side"]);
      expect(result.files.map((f) => f.path).toSorted()).toEqual(["a.txt", "side.txt"]);
    } finally {
      s.cleanup();
    }
  });

  it("counts a fast-forward range from Updating lines outside the window", async () => {
    const s = setup();
    try {
      s.write("a.txt", "1");
      const base = s.commit("base", T0 - 9000);
      s.git(["checkout", "-q", "-b", "feature"], T0 - 8000);
      s.write("f1.txt", "1");
      s.commit("f1", T0 - 7000);
      s.write("f2.txt", "2");
      const tip = s.commit("f2", T0 - 6000);
      s.git(["checkout", "-q", "main"], T0 - 5000);
      const result = await attributeRequest(
        snapshot(s.repo, [
          command(
            `git -C ${s.repo} merge feature`,
            `Updating ${base.slice(0, 7)}..${tip.slice(0, 7)}\nFast-forward`,
            10,
          ),
        ]),
        request,
        s.facts,
      );
      expect(result.commits.map((c) => [c.subject, c.role])).toEqual([
        ["f1", "range"],
        ["f2", "range"],
      ]);
      expect(result.files.map((f) => f.path)).toEqual(["f1.txt", "f2.txt"]);
    } finally {
      s.cleanup();
    }
  });

  it("recognizes a cherry-picked orphan by patch-id and reports file state", async () => {
    const s = setup();
    try {
      s.write("a.txt", "1");
      s.commit("base", T0 - 100);
      s.git(["checkout", "-q", "-b", "tmp"], T0 - 90);
      s.write("x.txt", "x");
      const orphan = s.commit("feat: x", T0 + 11);
      s.git(["checkout", "-q", "main"], T0 + 12);
      s.git(["cherry-pick", orphan], T0 + 21);
      s.git(["branch", "-q", "-D", "tmp"], T0 + 22);
      s.write("untracked.txt", "u");
      const result = await attributeRequest(
        snapshot(
          s.repo,
          [command(`git -C ${s.repo} commit -q -m x`, `[tmp ${orphan.slice(0, 7)}] feat: x`, 10)],
          [{ threadId: "T", runId: "T:1", path: NodePath.join(s.repo, "untracked.txt") }],
        ),
        request,
        s.facts,
      );
      const picked = result.commits.find((c) => c.hash === orphan);
      expect(picked).toMatchObject({ orphan: true, mergedVia: "patchId" });
      expect(picked?.mergedAs).not.toBeNull();
      expect(result.files.find((f) => f.path === "untracked.txt")?.state).toEqual({
        kind: "uncommitted",
      });
    } finally {
      s.cleanup();
    }
  });

  it("infers by unique title when the patch differs and leaves ambiguous titles alone", async () => {
    const s = setup();
    try {
      s.write("a.txt", "1");
      s.write("b.txt", "1");
      s.commit("base", T0 - 100);
      s.git(["checkout", "-q", "-b", "tmp"], T0 - 90);
      s.write("a.txt", "orphan");
      s.write("b.txt", "orphan");
      const orphan = s.commit("feat: rewrite", T0 + 11);
      s.git(["checkout", "-q", "main"], T0 + 12);
      s.write("a.txt", "rebased");
      s.write("b.txt", "rebased");
      s.commit("feat: rewrite", T0 + 21);
      s.git(["branch", "-q", "-D", "tmp"], T0 + 22);
      const run = (facts = s.facts) =>
        attributeRequest(
          snapshot(s.repo, [
            command(
              `git -C ${s.repo} commit -q -m x`,
              `[tmp ${orphan.slice(0, 7)}] feat: rewrite`,
              10,
            ),
          ]),
          request,
          facts,
        );
      const inferred = await run();
      expect(inferred.commits.find((c) => c.hash === orphan)).toMatchObject({ mergedVia: "title" });
      s.write("a.txt", "again");
      s.commit("feat: rewrite", T0 + 23);
      const ambiguous = await run(createGitFacts({ scanRoot: s.repo, home: s.repo }));
      expect(ambiguous.commits.find((c) => c.hash === orphan)?.mergedAs).toBeNull();
    } finally {
      s.cleanup();
    }
  });

  it("treats ignored file changes as deliverables", async () => {
    const s = setup();
    try {
      s.write(".gitignore", ".local/\n");
      s.write("a.txt", "1");
      s.commit("base", T0 - 100);
      s.write(".local/plan.md", "p");
      const result = await attributeRequest(
        snapshot(
          s.repo,
          [],
          [{ threadId: "T", runId: "T:1", path: NodePath.join(s.repo, ".local/plan.md") }],
        ),
        request,
        s.facts,
      );
      expect(result.files).toEqual([]);
      expect(result.deliverables).toEqual([NodePath.join(s.repo, ".local/plan.md")]);
    } finally {
      s.cleanup();
    }
  });
});
