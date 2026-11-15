// @effect-diagnostics nodeBuiltinImport:off
// The attribution core runs without an Effect runtime so a replay script can drive it; the server wraps it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { CommitInfo, GitFacts, MainlineMatch, RepoRef } from "./types.ts";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".local", "dist", "target"]);
const MAX_DISCOVERY_DEPTH = 7;
const MAX_RANGE_COMMITS = 200;
const MAX_MAINLINE_COMMITS = 300;
const COMMIT_FORMAT = "%H%x09%ct%x09%P%x09%s";
const WORKTREE_GITDIR = /^gitdir: (.+)\/\.git\/worktrees\/[^/]+\s*$/;

function parseCommits(output: string): ReadonlyArray<CommitInfo> {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = "", time = "0", parents = "", ...subject] = line.split("\t");
      return {
        hash,
        time: Number(time),
        parents: parents.split(" ").filter((p) => p.length > 0),
        subject: subject.join("\t"),
      };
    });
}

export function createGitFacts(options: {
  readonly scanRoot: string;
  readonly home: string;
  readonly concurrency?: number;
}): GitFacts {
  let calls = 0;
  let running = 0;
  const waiting: Array<() => void> = [];
  const limit = options.concurrency ?? 4;
  const acquire = async () => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
  };
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };

  const git = async (cwd: string, args: ReadonlyArray<string>, input?: string): Promise<string> => {
    calls += 1;
    await acquire();
    try {
      return await new Promise<string>((resolve) => {
        const child = NodeChildProcess.execFile(
          "git",
          ["-C", cwd, ...args],
          {
            maxBuffer: 256 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
          },
          (_error, stdout) => resolve(stdout),
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(input ?? "");
      });
    } finally {
      release();
    }
  };

  const repoCache = new Map<string, RepoRef | null>();
  const findRepo = (start: string): RepoRef | null => {
    let dir = start;
    const visited: string[] = [];
    let result: RepoRef | null = null;
    while (dir !== NodePath.dirname(dir)) {
      const cached = repoCache.get(dir);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      visited.push(dir);
      const dotGit = NodePath.join(dir, ".git");
      let stat: NodeFS.Stats | null = null;
      try {
        stat = NodeFS.statSync(dotGit);
      } catch {
        stat = null;
      }
      if (stat !== null) {
        let root = dir;
        if (stat.isFile()) {
          const match = WORKTREE_GITDIR.exec(NodeFS.readFileSync(dotGit, "utf8"));
          if (match !== null) root = match[1]!;
        }
        result = { workDir: dir, root };
        break;
      }
      dir = NodePath.dirname(dir);
    }
    for (const entry of visited) repoCache.set(entry, result);
    return result;
  };

  const mainlineCache = new Map<
    string,
    { since: number; commits: ReadonlyArray<CommitInfo>; patchIds: ReadonlyMap<string, string> }
  >();
  const patchIdOf = async (repo: string, hash: string) => {
    const diff = await git(repo, ["diff-tree", "-p", "--root", hash]);
    const out = await git(repo, ["patch-id", "--stable"], diff);
    return out.split(" ")[0] ?? "";
  };
  const mainline = async (repo: string, since: number) => {
    const cached = mainlineCache.get(repo);
    if (cached !== undefined && cached.since <= since) return cached;
    const commits = parseCommits(
      await git(repo, [
        "log",
        "--branches",
        `--since=@${since}`,
        `--max-count=${MAX_MAINLINE_COMMITS}`,
        `--format=${COMMIT_FORMAT}`,
      ]),
    );
    const patches = await git(repo, [
      "log",
      "--branches",
      `--since=@${since}`,
      `--max-count=${MAX_MAINLINE_COMMITS}`,
      "-p",
      "--format=commit %H",
    ]);
    const ids = await git(repo, ["patch-id", "--stable"], patches);
    const patchIds = new Map<string, string>();
    for (const line of ids.split("\n")) {
      const [patchId, commit] = line.split(" ");
      if (patchId !== undefined && commit !== undefined) patchIds.set(patchId, commit);
    }
    const entry = { since, commits, patchIds };
    mainlineCache.set(repo, entry);
    return entry;
  };

  return {
    callCount: () => calls,

    discoverRepos: async () => {
      const found: string[] = [];
      const walk = (dir: string, depth: number) => {
        let entries: NodeFS.Dirent[];
        try {
          entries = NodeFS.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        if (entries.some((e) => e.name === ".git")) found.push(dir);
        if (depth >= MAX_DISCOVERY_DEPTH) return;
        for (const entry of entries) {
          if (
            entry.isDirectory() &&
            !SKIPPED_DIRECTORIES.has(entry.name) &&
            entry.name !== ".git"
          ) {
            walk(NodePath.join(dir, entry.name), depth + 1);
          }
        }
      };
      walk(options.scanRoot, 0);
      return found;
    },

    repoOf: async (path) => {
      const absolute = path.startsWith("~/") ? NodePath.join(options.home, path.slice(2)) : path;
      let isDirectory = false;
      try {
        isDirectory = NodeFS.statSync(absolute).isDirectory();
      } catch {
        isDirectory = false;
      }
      return findRepo(isDirectory ? absolute : NodePath.dirname(absolute));
    },

    commitsInSpan: async (repo, sinceSec, untilSec) =>
      parseCommits(
        await git(repo, [
          "log",
          "--all",
          `--since=@${Math.floor(sinceSec)}`,
          `--until=@${Math.ceil(untilSec)}`,
          `--format=${COMMIT_FORMAT}`,
        ]),
      ),

    resolveCommits: async (repo, tokens) => {
      const checked = await git(
        repo,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        `${tokens.join("\n")}\n`,
      );
      const hashes = checked
        .split("\n")
        .map((line) => line.split(" "))
        .filter((parts) => parts.length === 2 && parts[1] === "commit")
        .map((parts) => parts[0]!);
      if (hashes.length === 0) return [];
      return parseCommits(
        await git(
          repo,
          ["log", "--no-walk=unsorted", "--stdin", `--format=${COMMIT_FORMAT}`],
          `${hashes.join("\n")}\n`,
        ),
      );
    },

    commitsInRange: async (repo, from, to) =>
      parseCommits(
        await git(repo, [
          "log",
          `--max-count=${MAX_RANGE_COMMITS}`,
          `--format=${COMMIT_FORMAT}`,
          `${from}..${to}`,
        ]),
      ),

    changedFiles: async (repo, hash) =>
      (
        await git(repo, [
          "log",
          "-1",
          "-m",
          "--first-parent",
          "--root",
          "--name-only",
          "-z",
          "--format=",
          hash,
        ])
      )
        .split("\0")
        .map((name) => name.replace(/^\n+/, ""))
        .filter((name) => name.length > 0),

    isReachable: async (repo, hash) =>
      (
        await git(repo, [
          "for-each-ref",
          "--count=1",
          `--contains=${hash}`,
          "refs/heads",
          "refs/remotes",
          "refs/tags",
        ])
      ).trim().length > 0,

    mainlineMatch: async (repo, commit): Promise<MainlineMatch> => {
      const since = commit.time - 60;
      const { commits, patchIds } = await mainline(repo, since);
      const own = await patchIdOf(repo, commit.hash);
      const byPatchIdHash = own === "" ? undefined : patchIds.get(own);
      return {
        byPatchId:
          byPatchIdHash === undefined || byPatchIdHash === commit.hash
            ? null
            : (commits.find((c) => c.hash === byPatchIdHash) ?? null),
        sameTitle: commits.filter((c) => c.subject === commit.subject && c.hash !== commit.hash),
      };
    },

    dirtyFiles: async (workDir) => {
      const out = await git(workDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const entries = out.split("\0");
      const dirty = new Set<string>();
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.length < 4) continue;
        dirty.add(entry.slice(3));
        if (entry[0] === "R" || entry[0] === "C") i += 1;
      }
      return dirty;
    },

    ignoredFiles: async (workDir, paths) => {
      if (paths.length === 0) return new Set();
      const out = await git(workDir, ["check-ignore", "--stdin", "-z"], `${paths.join("\0")}\0`);
      return new Set(out.split("\0").filter((p) => p.length > 0));
    },

    lastCommitTouching: async (repo, sinceSec, paths) => {
      if (paths.length === 0) return new Map();
      const out = await git(repo, [
        "log",
        "--all",
        `--since=@${Math.floor(sinceSec)}`,
        "--name-only",
        "--format=%x01%H",
        "--",
        ...paths,
      ]);
      const latest = new Map<string, string>();
      for (const block of out.split("\u0001")) {
        const [hash, ...names] = block.split("\n").filter((line) => line.length > 0);
        if (hash === undefined) continue;
        for (const name of names) if (!latest.has(name)) latest.set(name, hash);
      }
      return latest;
    },
  };
}
