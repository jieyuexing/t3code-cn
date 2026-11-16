// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// Plain async code on node builtins: read-only git facts, no Effect runtime needed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LocalReviewCommit, LocalReviewRepo } from "@t3tools/contracts";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".local", ".state", "dist", "target"]);
const MAX_DISCOVERY_DEPTH = 7;
const MAX_REPOS = 100;
const FIELD = "\u001f";
const RECORD = "\u001e";
const LOG_FORMAT = ["%H", "%P", "%an", "%ct", "%D", "%s", "%B"].join("%x1f") + "%x1e";

function parseRefs(decoration: string): ReadonlyArray<string> {
  return decoration
    .split(", ")
    .map((ref) => ref.replace(/^HEAD -> /, "").replace(/^tag: /, ""))
    .filter((ref) => ref.length > 0 && ref !== "HEAD");
}

function parseLog(repo: string, output: string): ReadonlyArray<LocalReviewCommit> {
  const commits: LocalReviewCommit[] = [];
  for (const record of output.split(RECORD)) {
    const [hash = "", parents = "", author = "", time = "0", refs = "", subject = "", ...rest] =
      record.replace(/^\n/, "").split(FIELD);
    if (hash === "") continue;
    commits.push({
      repo,
      hash,
      parents: parents.split(" ").filter((parent) => parent.length > 0),
      subject,
      message: rest.join(FIELD).trim(),
      author,
      committedAt: new Date(Number(time) * 1000).toISOString(),
      refs: parseRefs(refs),
    });
  }
  return commits;
}

function countChanges(output: string): number {
  const entries = output.split("\0");
  let count = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    count += 1;
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return count;
}

export function discoverRepos(roots: ReadonlyArray<string>): ReadonlyArray<LocalReviewRepo> {
  const found = new Map<string, string>();
  for (const root of roots) {
    const walk = (dir: string, depth: number) => {
      if (found.size >= MAX_REPOS) return;
      let entries: NodeFS.Dirent[];
      try {
        entries = NodeFS.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.name === ".git") && !found.has(dir)) {
        found.set(dir, dir === root ? NodePath.basename(root) : NodePath.relative(root, dir));
      }
      if (depth >= MAX_DISCOVERY_DEPTH) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && entry.name !== ".git") {
          walk(NodePath.join(dir, entry.name), depth + 1);
        }
      }
    };
    walk(root, 0);
  }
  return [...found]
    .map(([path, name]) => ({ path, name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function createGitHistory(options: { readonly concurrency?: number } = {}) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const limit = options.concurrency ?? 4;
  const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await new Promise<string>((resolve) => {
        NodeChildProcess.execFile(
          "git",
          ["-C", cwd, ...args],
          {
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
          },
          (_error, stdout) => resolve(stdout),
        );
      });
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  /** Newest `count` commits of the current HEAD per repo, merged by commit time. */
  const commits = async (repos: ReadonlyArray<LocalReviewRepo>, count: number) => {
    const perRepo = await Promise.all(
      repos.map(async (repo) =>
        parseLog(
          repo.path,
          await git(repo.path, [
            "log",
            "HEAD",
            `--max-count=${count + 1}`,
            `--format=${LOG_FORMAT}`,
          ]),
        ),
      ),
    );
    const merged = perRepo
      .flat()
      .toSorted((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
    return { commits: merged.slice(0, count), hasMore: merged.length > count };
  };

  // Untracked directories count once: listing every untracked file takes seconds in a big repo.
  const dirty = async (repos: ReadonlyArray<LocalReviewRepo>) => {
    const counts = await Promise.all(
      repos.map(async (repo) => ({
        repo: repo.path,
        changeCount: countChanges(
          await git(repo.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
        ),
      })),
    );
    return counts.filter((entry) => entry.changeCount > 0);
  };

  return { commits, dirty };
}
