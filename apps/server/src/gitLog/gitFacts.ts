// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// Plain async code on node builtins: read-only git facts, no Effect runtime needed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { GitLogCommit, GitLogRepo } from "@t3tools/contracts";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".local", ".state", "dist", "target"]);
const MAX_DISCOVERY_DEPTH = 7;
const MAX_REPOS = 100;
const FIELD = "\u001f";
const RECORD = "\u001e";
const LOG_FORMAT = ["%H", "%P", "%an", "%ct", "%D", "%s"].join("%x1f") + "%x1e";

function parseRefs(decoration: string): ReadonlyArray<string> {
  return decoration
    .split(", ")
    .map((ref) => ref.replace(/^HEAD -> /, "").replace(/^tag: /, ""))
    .filter((ref) => ref.length > 0 && ref !== "HEAD");
}

function parseLog(output: string): ReadonlyArray<GitLogCommit> {
  const commits: GitLogCommit[] = [];
  for (const record of output.split(RECORD)) {
    const [hash = "", parents = "", author = "", time = "0", refs = "", subject = ""] = record
      .replace(/^\n/, "")
      .split(FIELD);
    if (hash === "") continue;
    commits.push({
      hash,
      parents: parents.split(" ").filter((parent) => parent.length > 0),
      subject,
      author,
      committedAt: new Date(Number(time) * 1000).toISOString(),
      refs: parseRefs(refs),
    });
  }
  return commits;
}

export function discoverRepos(roots: ReadonlyArray<string>): ReadonlyArray<GitLogRepo> {
  const found = new Map<string, string>();
  for (const root of roots) {
    const walk = (dir: string, depth: number) => {
      if (found.size >= MAX_REPOS) return;
      let entries: NodeFS.Dirent[];
      try {
        entries = NodeFS.readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
          a.name.localeCompare(b.name),
        );
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
  return [...found].map(([path, name]) => ({ path, name }));
}

const SCAN_BATCH = 500;
const SCAN_LIMIT = 20_000;
const PATH_MATCH_LIMIT = 5_000;

const git = (cwd: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      // A repo without commits or a failed read lists nothing.
      (_error, stdout) => resolve(stdout),
    );
  });

/** Commits whose changed path contains `query`, as a set of hashes. */
async function commitsTouching(repo: string, query: string): Promise<ReadonlySet<string>> {
  const pathspec = `:(icase)*${query.replace(/[\\*?[]/g, "\\$&")}*`;
  const out = await git(repo, [
    "log",
    `--max-count=${PATH_MATCH_LIMIT}`,
    "--format=%H",
    "--",
    pathspec,
  ]);
  return new Set(out.split("\n").filter((hash) => hash.length > 0));
}

/**
 * Newest `limit` commits of the current HEAD in topological order (a parent always follows its
 * children, which the branch graph needs). `query` keeps commits whose subject, author or hash
 * contains it, or that touch a path containing it; `hasMore` says whether older ones exist.
 */
export async function readLog(
  repo: string,
  options: { readonly limit: number; readonly query: string },
): Promise<{ readonly commits: ReadonlyArray<GitLogCommit>; readonly hasMore: boolean }> {
  const needle = options.query.trim().toLowerCase();
  const touching = needle === "" ? null : await commitsTouching(repo, needle);
  const matches = (commit: GitLogCommit) =>
    needle === "" ||
    commit.subject.toLowerCase().includes(needle) ||
    commit.author.toLowerCase().includes(needle) ||
    commit.hash.includes(needle) ||
    touching?.has(commit.hash) === true;
  const batch = needle === "" ? options.limit + 1 : SCAN_BATCH;
  const found: GitLogCommit[] = [];
  for (let position = 0; position < SCAN_LIMIT; position += batch) {
    const fetched = parseLog(
      await git(repo, [
        "log",
        "--topo-order",
        `--skip=${position}`,
        `--max-count=${batch}`,
        `--format=${LOG_FORMAT}`,
      ]),
    );
    for (const commit of fetched) if (matches(commit)) found.push(commit);
    if (fetched.length < batch || found.length > options.limit) break;
  }
  return { commits: found.slice(0, options.limit), hasMore: found.length > options.limit };
}
