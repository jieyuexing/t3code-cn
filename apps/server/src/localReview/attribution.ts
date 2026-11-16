import { isCommitCommand, lastChangedDirectory, literalPaths, parseMentions } from "./mentions.ts";
import type {
  BlindSpot,
  CommitInfo,
  FileState,
  GitFacts,
  Request,
  RequestCommit,
  RequestFile,
  RequestFiles,
  Scope,
  Snapshot,
  SnapshotCommand,
  SnapshotRun,
  SourceLayer,
} from "./types.ts";

const INTERVAL_MARGIN_SEC = 3;
const MAX_FILES = 500;
const GIT_BUDGET = 150;
const MAX_FOLD_DEPTH = 8;
const OUTPUT_LIMIT = 1_048_000;
const MIN_TITLE_OVERLAP = 0.5;
const CHECKPOINT_SUBJECT = "t3 checkpoint";
const TEMP_WORKTREE = /^(.*\/\.local\/tmp\/[^/]+\/wt-[^/]+)\/(.+)$/;

const TITLE_LENGTH = 120;

function firstLine(value: string): string {
  const line = value.split("\n").find((part) => part.trim().length > 0) ?? "";
  return line.trim().slice(0, TITLE_LENGTH);
}

export function groupRequests(runs: ReadonlyArray<SnapshotRun>): ReadonlyArray<Request> {
  const sorted = runs.toSorted((a, b) => a.ordinal - b.ordinal);
  const requests: Array<{
    id: string;
    threadId: string;
    runIds: string[];
    origin: "user" | "agent";
    title: string;
    startedAt: number;
    endedAt: number;
    running: boolean;
  }> = [];
  const requestOfRun = new Map<string, (typeof requests)[number]>();
  for (const run of sorted) {
    const { delegatedParentRunId, backgroundNotification, createdBy } = run.cause;
    const previous = requests.at(-1);
    const joined =
      delegatedParentRunId !== null
        ? (requestOfRun.get(delegatedParentRunId) ?? previous)
        : backgroundNotification
          ? previous
          : undefined;
    const target =
      joined ??
      (() => {
        const created = {
          id: run.runId,
          threadId: run.threadId,
          runIds: [] as string[],
          origin: createdBy === "user" ? ("user" as const) : ("agent" as const),
          title: firstLine(run.messageText),
          startedAt: run.requestedAt,
          endedAt: run.requestedAt,
          running: false,
        };
        requests.push(created);
        return created;
      })();
    target.runIds.push(run.runId);
    target.endedAt = Math.max(target.endedAt, run.completedAt ?? run.requestedAt);
    if (run.completedAt === null) target.running = true;
    requestOfRun.set(run.runId, target);
  }
  return requests;
}

export function foldChildren(
  snapshot: Snapshot,
  threadId: string,
  runIds: ReadonlySet<string>,
): ReadonlyArray<Scope> {
  const scopes: Scope[] = [{ threadId, runIds }];
  const visited = new Set([threadId]);
  const walk = (parent: string, parentRuns: ReadonlySet<string> | null, depth: number) => {
    if (depth >= MAX_FOLD_DEPTH) return;
    for (const row of snapshot.subagents) {
      if (row.threadId !== parent || row.childThreadId === null) continue;
      if (parentRuns !== null && (row.runId === null || !parentRuns.has(row.runId))) continue;
      if (visited.has(row.childThreadId)) continue;
      visited.add(row.childThreadId);
      scopes.push({ threadId: row.childThreadId, runIds: null });
      walk(row.childThreadId, null, depth + 1);
    }
  };
  walk(threadId, runIds, 0);
  return scopes;
}

interface Pending {
  readonly info: CommitInfo;
  readonly repo: string;
  role: "output" | "range";
  fromChild: boolean;
}

interface PreparedCommand {
  readonly child: boolean;
  readonly input: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly verb: boolean;
  readonly candidates: ReadonlySet<string>;
  readonly command: SnapshotCommand;
}

interface FileEntry {
  readonly repo: string;
  readonly path: string;
  readonly sources: Set<SourceLayer>;
  readonly commits: Map<string, number>;
  readonly workDirs: Set<string>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function guarded(git: GitFacts, budget: number) {
  const startCalls = git.callCount();
  let exhausted = false;
  const spent = () => git.callCount() - startCalls;
  const run = async <T>(fallback: T, call: () => Promise<T>): Promise<T> => {
    if (spent() >= budget) {
      exhausted = true;
      return fallback;
    }
    return call();
  };
  return {
    spent,
    exhausted: () => exhausted,
    repoOf: git.repoOf,
    discoverRepos: git.discoverRepos,
    commitsInSpan: (repo: string, since: number, until: number) =>
      run<ReadonlyArray<CommitInfo>>([], () => git.commitsInSpan(repo, since, until)),
    resolveCommits: (repo: string, tokens: ReadonlyArray<string>) =>
      run<ReadonlyArray<CommitInfo>>([], () => git.resolveCommits(repo, tokens)),
    commitsInRange: (repo: string, from: string, to: string) =>
      run<ReadonlyArray<CommitInfo>>([], () => git.commitsInRange(repo, from, to)),
    changedFiles: (repo: string, hash: string) =>
      run<ReadonlyArray<string>>([], () => git.changedFiles(repo, hash)),
    isReachable: (repo: string, hash: string) => run(true, () => git.isReachable(repo, hash)),
    mainlineMatch: (repo: string, commit: CommitInfo) =>
      run({ byPatchId: null, sameTitle: [] }, () => git.mainlineMatch(repo, commit)),
    dirtyFiles: (workDir: string) =>
      run<ReadonlySet<string>>(new Set(), () => git.dirtyFiles(workDir)),
    ignoredFiles: (workDir: string, paths: ReadonlyArray<string>) =>
      run<ReadonlySet<string>>(new Set(), () => git.ignoredFiles(workDir, paths)),
    lastCommitTouching: (repo: string, since: number, paths: ReadonlyArray<string>) =>
      run<ReadonlyMap<string, string>>(new Map(), () => git.lastCommitTouching(repo, since, paths)),
  };
}

export async function attributeRequest(
  snapshot: Snapshot,
  request: Request,
  gitFacts: GitFacts,
  options: { readonly gitBudget?: number; readonly maxFiles?: number } = {},
): Promise<RequestFiles> {
  const git = guarded(gitFacts, options.gitBudget ?? GIT_BUDGET);
  const scopes = foldChildren(snapshot, request.threadId, new Set(request.runIds));
  const threadCwd = new Map(snapshot.threads.map((t) => [t.threadId, t.cwd]));
  const inScope = (scope: Scope, item: { threadId: string; runId: string | null }) =>
    item.threadId === scope.threadId &&
    (scope.runIds === null || (item.runId !== null && scope.runIds.has(item.runId)));

  const repoCache = new Map<string, ReturnType<GitFacts["repoOf"]>>();
  const repoOf = (path: string) => {
    let hit = repoCache.get(path);
    if (hit === undefined) {
      hit = git.repoOf(path);
      repoCache.set(path, hit);
    }
    return hit;
  };
  const resolveInRepo = async (path: string) => {
    const ref = await repoOf(path);
    const worktree = TEMP_WORKTREE.exec(path);
    if (worktree !== null && (ref === null || !ref.workDir.startsWith(worktree[1]!))) return null;
    return ref;
  };

  const entries = new Map<string, FileEntry>();
  const entryFor = (repo: string, path: string, workDir: string | null) => {
    const key = `${repo}\0${path}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { repo, path, sources: new Set(), commits: new Map(), workDirs: new Set() };
      entries.set(key, entry);
    }
    if (workDir !== null) entry.workDirs.add(workDir);
    return entry;
  };

  const deliverables = new Set<string>();
  const clearedPaths: Array<{ rel: string; child: boolean }> = [];
  const fcRepos = new Set<string>();
  const allFileChangePaths: string[] = [];
  const scopeFcRepos: Array<Set<string>> = [];
  const cwdRepos: Array<string | null> = [];

  for (const [index, scope] of scopes.entries()) {
    const child = index > 0;
    const repos = new Set<string>();
    scopeFcRepos.push(repos);
    const cwd = threadCwd.get(scope.threadId) ?? null;
    const cwdRef = cwd === null ? null : await repoOf(cwd);
    cwdRepos.push(cwdRef?.root ?? null);

    const kept = new Map<string, { root: string; workDir: string; rel: string }>();
    const paths = new Set(snapshot.fileChanges.filter((f) => inScope(scope, f)).map((f) => f.path));
    for (const path of paths) {
      allFileChangePaths.push(path);
      const ref = await resolveInRepo(path);
      const worktree = TEMP_WORKTREE.exec(path);
      if (ref === null) {
        if (worktree === null) deliverables.add(path);
        else clearedPaths.push({ rel: worktree[2]!, child });
        continue;
      }
      kept.set(path, {
        root: ref.root,
        workDir: ref.workDir,
        rel: path.slice(ref.workDir.length + 1),
      });
    }
    const byWorkDir = Map.groupBy(kept.entries(), ([, v]) => v.workDir);
    for (const [workDir, items] of byWorkDir) {
      const ignored = await git.ignoredFiles(
        workDir,
        items.map(([, v]) => v.rel),
      );
      for (const [path, v] of items) {
        if (ignored.has(v.rel)) {
          deliverables.add(path);
          continue;
        }
        repos.add(v.root);
        fcRepos.add(v.root);
        const entry = entryFor(v.root, v.rel, v.workDir);
        entry.sources.add("fileChange");
        if (child) entry.sources.add("child");
      }
    }

    if (cwdRef !== null) {
      for (const checkpoint of snapshot.checkpoints) {
        if (!inScope(scope, { threadId: checkpoint.threadId, runId: checkpoint.runId })) continue;
        for (const file of checkpoint.files) {
          const entry = entryFor(cwdRef.root, file, cwdRef.workDir);
          entry.sources.add("checkpoint");
          if (child) entry.sources.add("child");
        }
      }
    }
  }

  const prepared: PreparedCommand[] = [];
  let truncated = false;
  for (const [index, scope] of scopes.entries()) {
    const child = index > 0;
    let shellDir: string | null = null;
    const scopeCommands = snapshot.commands
      .filter((command) => inScope(scope, command))
      .toSorted((a, b) => a.startedAt - b.startedAt);
    for (const command of scopeCommands) {
      if (command.output.length >= OUTPUT_LIMIT) truncated = true;
      const candidates = new Set<string>(scopeFcRepos[index]);
      let named = false;
      for (const path of literalPaths(command.input)) {
        const ref = await resolveInRepo(path);
        if (ref !== null) {
          candidates.add(ref.root);
          named = true;
        }
      }
      if (!named) {
        const ref = shellDir === null ? null : await resolveInRepo(shellDir);
        const fallback = ref?.root ?? cwdRepos[index];
        if (fallback !== null && fallback !== undefined) candidates.add(fallback);
      }
      shellDir = lastChangedDirectory(command.input) ?? shellDir;
      prepared.push({
        child,
        input: command.input,
        startSec: command.startedAt / 1000,
        endSec: (command.completedAt ?? command.startedAt) / 1000,
        verb: isCommitCommand(command.input),
        candidates,
        command,
      });
    }
  }
  prepared.sort((a, b) => a.startSec - b.startSec);

  const spanCache = new Map<
    string,
    { since: number; until: number; commits: ReadonlyArray<CommitInfo> }
  >();
  const logSpan = async (repo: string, since: number, until: number) => {
    const cached = spanCache.get(repo);
    if (cached !== undefined && cached.since <= since && cached.until >= until) {
      return cached.commits;
    }
    const from = Math.min(since, cached?.since ?? since);
    const to = Math.max(until, cached?.until ?? until);
    const commits = await git.commitsInSpan(repo, from, to);
    spanCache.set(repo, { since: from, until: to, commits });
    return commits;
  };
  const inInterval = (command: PreparedCommand, commit: CommitInfo) =>
    commit.time >= command.startSec - INTERVAL_MARGIN_SEC &&
    commit.time <= command.endSec + INTERVAL_MARGIN_SEC;
  const spanOf = (commands: ReadonlyArray<PreparedCommand>) => ({
    since: Math.min(...commands.map((c) => c.startSec)) - INTERVAL_MARGIN_SEC,
    until: Math.max(...commands.map((c) => c.endSec)) + INTERVAL_MARGIN_SEC,
  });

  const accepted = new Map<string, Pending>();
  const accept = (repo: string, info: CommitInfo, role: "output" | "range", child: boolean) => {
    if (info.subject.startsWith(CHECKPOINT_SUBJECT)) return;
    const key = `${repo}\0${info.hash}`;
    const existing = accepted.get(key);
    if (existing === undefined) accepted.set(key, { info, repo, role, fromChild: child });
    else {
      if (role === "output") existing.role = "output";
      existing.fromChild = existing.fromChild && child;
    }
  };

  const verbCommands = prepared.filter((c) => c.verb);
  const firstPassRepos = new Set(verbCommands.flatMap((c) => [...c.candidates]));
  await Promise.all(
    [...firstPassRepos].map(async (repo) => {
      const using = verbCommands.filter((c) => c.candidates.has(repo));
      const { since, until } = spanOf(using);
      await logSpan(repo, since, until);
    }),
  );

  const mentioned = new Set<string>();
  const tokensByRepo = new Map<string, Set<string>>();
  const mentionsOf = new Map<PreparedCommand, ReturnType<typeof parseMentions>>();
  for (const command of prepared) {
    const mentions = parseMentions(command.command.output);
    mentionsOf.set(command, mentions);
    const tokens = [
      ...mentions.commits.map((m) => m.token),
      ...mentions.ranges.flatMap((r) => [r.from, r.to]),
    ];
    if (tokens.length === 0) continue;
    for (const repo of command.candidates) {
      const set = tokensByRepo.get(repo) ?? new Set();
      for (const token of tokens) set.add(token);
      tokensByRepo.set(repo, set);
    }
  }
  const resolved = new Map<string, ReadonlyArray<CommitInfo>>();
  for (const [repo, tokens] of tokensByRepo) {
    resolved.set(repo, await git.resolveCommits(repo, [...tokens]));
  }
  const lookup = (repo: string, token: string) =>
    resolved.get(repo)?.find((c) => c.hash.startsWith(token));

  for (const command of prepared) {
    const mentions = mentionsOf.get(command)!;
    for (const mention of mentions.commits) {
      for (const repo of command.candidates) {
        const info = lookup(repo, mention.token);
        if (info === undefined || info.subject.startsWith(CHECKPOINT_SUBJECT)) continue;
        if (!inInterval(command, info)) continue;
        if (mention.form === "bracket" || command.verb) accept(repo, info, "output", command.child);
        else mentioned.add(`${repo}\0${info.hash}`);
      }
    }
    if (/\bgit\b[^\n]*?\b(push|pull|merge)\b/.test(command.input)) {
      for (const range of mentions.ranges) {
        for (const repo of command.candidates) {
          const from = lookup(repo, range.from);
          const to = lookup(repo, range.to);
          if (from === undefined || to === undefined) continue;
          for (const info of await git.commitsInRange(repo, from.hash, to.hash)) {
            accept(repo, info, "range", command.child);
          }
        }
      }
    }
  }

  const fileChangeSuffixes = allFileChangePaths;
  // Root-level file names (ETECH.md, plugin.json) exist in many repos, so only a path with a directory or the repo's own name counts.
  const hasPathEvidence = async (repo: string, command: PreparedCommand, info: CommitInfo) => {
    const name = repo.slice(repo.lastIndexOf("/") + 1);
    if (new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w/-])`).test(command.input)) return true;
    const files = (await git.changedFiles(repo, info.hash)).filter((file) => file.includes("/"));
    return files.some(
      (file) =>
        command.input.includes(file) || fileChangeSuffixes.some((p) => p.endsWith(`/${file}`)),
    );
  };

  const unmatched: PreparedCommand[] = [];
  for (const command of verbCommands) {
    let found = 0;
    for (const repo of command.candidates) {
      const commits = await logSpan(repo, command.startSec - 3, command.endSec + 3);
      for (const info of commits) {
        if (!inInterval(command, info) || info.subject.startsWith(CHECKPOINT_SUBJECT)) continue;
        found += 1;
        accept(repo, info, "output", command.child);
      }
    }
    if (found === 0) unmatched.push(command);
  }
  if (unmatched.length > 0) {
    const all = await git.discoverRepos();
    const { since, until } = spanOf(unmatched);
    for (const repo of all) {
      const commits = await logSpan(repo, since, until);
      for (const command of unmatched) {
        for (const info of commits) {
          if (!inInterval(command, info) || info.subject.startsWith(CHECKPOINT_SUBJECT)) continue;
          if (accepted.has(`${repo}\0${info.hash}`)) continue;
          if (await hasPathEvidence(repo, command, info))
            accept(repo, info, "output", command.child);
        }
      }
    }
  }

  const evidenceRepos = new Set([...fcRepos, ...[...accepted.values()].map((p) => p.repo)]);
  for (const command of verbCommands) {
    for (const repo of evidenceRepos) {
      const commits = await logSpan(repo, command.startSec - 3, command.endSec + 3);
      for (const info of commits) {
        if (inInterval(command, info)) accept(repo, info, "output", command.child);
      }
    }
  }

  const byHash = Map.groupBy([...accepted.values()], (p) => p.info.hash);
  const requestCommits: RequestCommit[] = [];
  const commitFiles = new Map<string, ReadonlyArray<string>>();
  const filesOfCommit = async (repo: string, hash: string) => {
    const key = `${repo}\0${hash}`;
    let files = commitFiles.get(key);
    if (files === undefined) {
      files = await git.changedFiles(repo, hash);
      commitFiles.set(key, files);
    }
    return files;
  };
  for (const [hash, group] of byHash) {
    const chosen = group.find((p) => evidenceRepos.has(p.repo)) ?? group[0]!;
    const files = await filesOfCommit(chosen.repo, hash);
    for (const file of files) {
      const entry = entryFor(chosen.repo, file, null);
      entry.sources.add(chosen.role);
      if (chosen.fromChild) entry.sources.add("child");
      entry.commits.set(hash, chosen.info.time);
    }
    const orphan = !(await git.isReachable(chosen.repo, hash));
    let mergedAs: string | null = null;
    let mergedVia: "patchId" | "title" | null = null;
    if (orphan) {
      const match = await git.mainlineMatch(chosen.repo, chosen.info);
      if (match.byPatchId !== null) {
        mergedAs = match.byPatchId.hash;
        mergedVia = "patchId";
      } else if (match.sameTitle.length === 1) {
        const candidate = match.sameTitle[0]!;
        const other = new Set(await filesOfCommit(chosen.repo, candidate.hash));
        const overlap = files.filter((f) => other.has(f)).length;
        if (files.length > 0 && overlap / files.length >= MIN_TITLE_OVERLAP) {
          mergedAs = candidate.hash;
          mergedVia = "title";
        }
      }
    }
    requestCommits.push({
      repo: chosen.repo,
      hash,
      subject: chosen.info.subject,
      time: chosen.info.time,
      role: group.some((p) => p.role === "output") ? "output" : "range",
      orphan,
      mergedAs,
      mergedVia,
      alsoIn: group.filter((p) => p !== chosen).map((p) => p.repo),
      fromChild: group.every((p) => p.fromChild),
    });
  }

  let clearedWorktrees = 0;
  for (const { rel, child } of clearedPaths) {
    let matched = false;
    for (const entry of entries.values()) {
      if (entry.path !== rel || entry.commits.size === 0) continue;
      entry.sources.add("fileChange");
      if (child) entry.sources.add("child");
      matched = true;
    }
    if (!matched) clearedWorktrees += 1;
  }

  const requestStartSec = request.startedAt / 1000;
  const byRepo = Map.groupBy(entries.values(), (e) => e.repo);
  const stateOf = new Map<FileEntry, FileState>();
  for (const [repo, repoEntries] of byRepo) {
    const open = repoEntries.filter((e) => e.commits.size === 0);
    for (const entry of repoEntries) {
      if (entry.commits.size > 0) {
        const latest = [...entry.commits].toSorted((a, b) => b[1] - a[1])[0]![0];
        stateOf.set(entry, { kind: "committed", hash: latest });
      }
    }
    if (open.length === 0) continue;
    const dirty = new Set<string>();
    for (const workDir of new Set(open.flatMap((e) => [...e.workDirs]))) {
      for (const path of await git.dirtyFiles(workDir)) dirty.add(path);
    }
    const stillOpen = open.filter((e) => !dirty.has(e.path));
    for (const entry of open) {
      if (dirty.has(entry.path)) stateOf.set(entry, { kind: "uncommitted" });
    }
    if (stillOpen.length > 0) {
      const later = await git.lastCommitTouching(
        repo,
        requestStartSec,
        stillOpen.map((e) => e.path),
      );
      for (const entry of stillOpen) {
        const hash = later.get(entry.path);
        stateOf.set(entry, hash === undefined ? { kind: "unknown" } : { kind: "committed", hash });
      }
    }
  }

  const maxFiles = options.maxFiles ?? MAX_FILES;
  const sorted = [...entries.values()].toSorted(
    (a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path),
  );
  const files: RequestFile[] = sorted.slice(0, maxFiles).map((entry) => ({
    repo: entry.repo,
    path: entry.path,
    sources: [...entry.sources],
    commits: [...entry.commits.keys()],
    state: stateOf.get(entry) ?? { kind: "unknown" },
  }));

  const blindSpots: BlindSpot[] = [];
  if (truncated) blindSpots.push("output-truncated");
  if (git.exhausted()) blindSpots.push("git-budget");
  return {
    files,
    commits: requestCommits.toSorted((a, b) => a.time - b.time),
    deliverables: [...deliverables].toSorted(),
    mentionedCommits: mentioned.size,
    clearedWorktrees,
    omittedFiles: Math.max(0, sorted.length - maxFiles),
    blindSpots,
    gitCalls: git.spent(),
  };
}

export function hasChanges(result: RequestFiles): boolean {
  return result.files.length > 0 || result.deliverables.length > 0;
}
