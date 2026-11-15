import { describe, expect, it } from "vite-plus/test";

import { attributeRequest, foldChildren, groupRequests, hasChanges } from "./attribution.ts";
import { parseMentions } from "./mentions.ts";
import type {
  CommitInfo,
  GitFacts,
  MainlineMatch,
  Request,
  RunCause,
  Snapshot,
  SnapshotCommand,
  SnapshotRun,
} from "./types.ts";

const T0 = 1_800_000_000;
const hex = (n: number) => `${n.toString(16).padStart(7, "0")}abcdef0123`.repeat(3).slice(0, 40);
const short = (n: number) => hex(n).slice(0, 7);

interface FakeCommit {
  readonly repo: string;
  readonly n: number;
  readonly subject: string;
  readonly time: number;
  readonly files: ReadonlyArray<string>;
  readonly parents?: ReadonlyArray<number>;
  readonly orphan?: boolean;
}

interface World {
  readonly repos: ReadonlyArray<string>;
  readonly commits?: ReadonlyArray<FakeCommit>;
  readonly ranges?: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly dirty?: ReadonlyArray<string>;
  readonly ignored?: ReadonlyArray<string>;
  readonly later?: Readonly<Record<string, string>>;
  readonly mainline?: Readonly<Record<number, MainlineMatch>>;
}

function info(c: FakeCommit): CommitInfo {
  return {
    hash: hex(c.n),
    subject: c.subject,
    time: c.time,
    parents: (c.parents ?? [c.n - 1000]).map(hex),
  };
}

function fakeGit(world: World): GitFacts {
  let calls = 0;
  const commits = world.commits ?? [];
  const counted =
    <A extends ReadonlyArray<unknown>, R>(fn: (...args: A) => R) =>
    (...args: A): Promise<R> => {
      calls += 1;
      return Promise.resolve(fn(...args));
    };
  const find = (repo: string, hash: string) =>
    commits.find((c) => c.repo === repo && hex(c.n) === hash);
  return {
    callCount: () => calls,
    discoverRepos: () => Promise.resolve(world.repos),
    repoOf: (path) => {
      const root = world.repos
        .filter((r) => path === r || path.startsWith(`${r}/`))
        .toSorted((a, b) => b.length - a.length)[0];
      return Promise.resolve(root === undefined ? null : { workDir: root, root });
    },
    commitsInSpan: counted((repo, since, until) =>
      commits.filter((c) => c.repo === repo && c.time >= since && c.time <= until).map(info),
    ),
    resolveCommits: counted((repo, tokens) =>
      commits
        .filter((c) => c.repo === repo && tokens.some((t) => hex(c.n).startsWith(t)))
        .map(info),
    ),
    commitsInRange: counted((repo, from, to) =>
      (world.ranges?.[`${from}..${to}`] ?? [])
        .map((n) => commits.find((c) => c.repo === repo && c.n === n))
        .flatMap((c) => (c === undefined ? [] : [info(c)])),
    ),
    changedFiles: counted((repo, hash) => find(repo, hash)?.files ?? []),
    isReachable: counted((repo, hash) => find(repo, hash)?.orphan !== true),
    mainlineMatch: counted(
      (_repo, commit): MainlineMatch =>
        world.mainline?.[Number.parseInt(commit.hash.slice(0, 7), 16)] ?? {
          byPatchId: null,
          sameTitle: [],
        },
    ),
    dirtyFiles: counted(() => new Set(world.dirty ?? [])),
    ignoredFiles: counted(
      (_dir, paths) => new Set(paths.filter((p) => world.ignored?.includes(p))),
    ),
    lastCommitTouching: counted(() => new Map(Object.entries(world.later ?? {}))),
  };
}

const cause = (extra: Partial<RunCause> = {}): RunCause => ({
  createdBy: "user",
  delegatedParentRunId: null,
  backgroundNotification: false,
  ...extra,
});

const run = (ordinal: number, extra: Partial<RunCause> = {}, thread = "T"): SnapshotRun => ({
  runId: `${thread}:${ordinal}`,
  threadId: thread,
  ordinal,
  requestedAt: (T0 + ordinal * 100) * 1000,
  completedAt: (T0 + ordinal * 100 + 50) * 1000,
  cause: cause(extra),
});

const command = (
  input: string,
  output: string,
  startSec: number,
  extra: Partial<SnapshotCommand> = {},
): SnapshotCommand => ({
  threadId: "T",
  runId: "T:1",
  startedAt: (T0 + startSec) * 1000,
  completedAt: (T0 + startSec + 2) * 1000,
  input,
  output,
  ...extra,
});

const snapshot = (parts: Partial<Snapshot> = {}): Snapshot => ({
  runs: [],
  threads: [{ threadId: "T", cwd: "/u" }],
  subagents: [],
  commands: [],
  fileChanges: [],
  checkpoints: [],
  ...parts,
});

const request: Request = {
  id: "T:1",
  threadId: "T",
  runIds: ["T:1"],
  origin: "user",
  startedAt: T0 * 1000,
  endedAt: (T0 + 60) * 1000,
};

const paths = (result: Awaited<ReturnType<typeof attributeRequest>>) =>
  result.files.map((f) => `${f.repo}:${f.path}`);

describe("parseMentions", () => {
  it("reads structured commit marks and ignores bare numbers", () => {
    const output = [
      `[main ${short(1)}] docs: one`,
      `[main (root-commit) ${short(2)}] init`,
      `commit ${hex(3)}`,
      `${hex(4)}`,
      `${short(5)}ab fix: two`,
      "total 1234567",
      "1234567 files changed",
      "7654321 bytes",
    ].join("\n");
    const found = parseMentions(output).commits;
    expect(found.map((m) => [m.token, m.form])).toEqual([
      [short(1), "bracket"],
      [short(2), "bracket"],
      [hex(3), "commit"],
      [hex(4), "full"],
      [`${short(5)}ab`, "oneline"],
    ]);
  });

  it("reads Updating and push ranges", () => {
    expect(parseMentions("Updating aaaaaaa..bbbbbbb\nFast-forward").ranges).toEqual([
      { from: "aaaaaaa", to: "bbbbbbb" },
    ]);
  });
});

describe("groupRequests", () => {
  it("folds completion notices by parentRunId and background notices into the previous request", () => {
    const requests = groupRequests([
      run(1),
      run(2),
      run(3, { createdBy: "agent", delegatedParentRunId: "T:1" }),
      run(4, { createdBy: "agent", backgroundNotification: true }),
      run(5, { createdBy: "agent" }),
    ]);
    expect(requests.map((r) => [r.runIds, r.origin])).toEqual([
      [["T:1", "T:3"], "user"],
      [["T:2", "T:4"], "user"],
      [["T:5"], "agent"],
    ]);
  });

  it("falls back to the previous request when the parent run is unknown", () => {
    const requests = groupRequests([
      run(1),
      run(2, { createdBy: "agent", delegatedParentRunId: "gone" }),
    ]);
    expect(requests.map((r) => r.runIds)).toEqual([["T:1", "T:2"]]);
  });
});

describe("foldChildren", () => {
  const sub = (threadId: string, runId: string | null, childThreadId: string | null) => ({
    threadId,
    runId,
    childThreadId,
  });

  it("follows nested children, survives a cycle and skips rows without a child", () => {
    const scopes = foldChildren(
      snapshot({
        subagents: [
          sub("T", "T:1", "C1"),
          sub("T", "T:1", null),
          sub("C1", null, "C2"),
          sub("C2", null, "T"),
        ],
      }),
      "T",
      new Set(["T:1"]),
    );
    expect(scopes.map((s) => s.threadId)).toEqual(["T", "C1", "C2"]);
  });

  it("only takes children started by the request's runs", () => {
    const scopes = foldChildren(
      snapshot({ subagents: [sub("T", "T:2", "C1")] }),
      "T",
      new Set(["T:1"]),
    );
    expect(scopes.map((s) => s.threadId)).toEqual(["T"]);
  });
});

describe("attributeRequest", () => {
  const repoA = "/u/a";
  const repoB = "/u/b";

  it("takes the commit a command printed inside its interval", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "docs: one", time: T0 + 11, files: ["x.md", "y.md"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command(`cd ${repoA} && git commit -m x`, `[main ${short(1)}] docs: one`, 10)],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:x.md`, `${repoA}:y.md`]);
    expect(result.files[0]?.sources).toEqual(["output"]);
    expect(result.commits.map((c) => c.role)).toEqual(["output"]);
  });

  it("finds a silent commit -q by probing the command interval", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [{ repo: repoA, n: 1, subject: "x", time: T0 + 11, files: ["x.md"] }],
    };
    const result = await attributeRequest(
      snapshot({ commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)] }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:x.md`]);
  });

  it("finds a merge commit that prints no number and uses its first-parent files", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "Merge x", time: T0 + 11, files: ["m.ts"], parents: [5, 6] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command(`git -C ${repoA} merge x`, "Merge made by the 'ort' strategy.", 10)],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:m.ts`]);
  });

  it("counts a fast-forward range even when the commits predate the window", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "old a", time: T0 - 5000, files: ["a.ts"] },
        { repo: repoA, n: 2, subject: "old b", time: T0 - 4000, files: ["b.ts"] },
      ],
      ranges: { [`${hex(1)}..${hex(2)}`]: [1, 2] },
    };
    const result = await attributeRequest(
      snapshot({
        commands: [
          command(
            `git -C ${repoA} merge feature`,
            `Updating ${short(1)}..${short(2)}\nFast-forward`,
            10,
          ),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:a.ts`, `${repoA}:b.ts`]);
    expect(result.commits.map((c) => c.role)).toEqual(["range", "range"]);
  });

  it("ignores old commits that git log prints and only mentions in-window ones", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "old", time: T0 - 9000, files: ["old.ts"] },
        { repo: repoA, n: 2, subject: "other thread", time: T0 + 11, files: ["other.ts"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command(`git -C ${repoA} log -5`, `commit ${hex(1)}\n\ncommit ${hex(2)}`, 10)],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files).toEqual([]);
    expect(result.mentionedCommits).toBe(1);
  });

  it("drops T3 checkpoint commits", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [{ repo: repoA, n: 1, subject: "t3 checkpoint 3", time: T0 + 11, files: ["c.ts"] }],
    };
    const result = await attributeRequest(
      snapshot({ commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)] }),
      request,
      fakeGit(world),
    );
    expect(result.files).toEqual([]);
  });

  it("does not let a checkpoint commit in the candidate repo suppress the all-repos fallback", async () => {
    const world: World = {
      repos: ["/u", repoA, repoB],
      commits: [
        { repo: "/u", n: 1, subject: "t3 checkpoint 9", time: T0 + 11, files: ["c.ts"] },
        { repo: repoB, n: 2, subject: "mine", time: T0 + 11, files: ["src/mine.ts"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({ commands: [command("git add src/mine.ts && git commit -q -m x", "", 10)] }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoB}:src/mine.ts`]);
  });

  it("prefers the evidence repo when a commit exists in two checkouts", async () => {
    const world: World = {
      repos: ["/u", repoA, repoB],
      commits: [
        { repo: repoA, n: 1, subject: "x", time: T0 + 11, files: ["x.ts"] },
        { repo: repoB, n: 1, subject: "x", time: T0 + 11, files: ["x.ts"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command(`git -C ${repoA} commit -q -m x; git -C ${repoB} log`, "", 10)],
        fileChanges: [{ threadId: "T", runId: "T:1", path: `${repoB}/x.ts` }],
      }),
      request,
      fakeGit(world),
    );
    expect(result.commits.map((c) => [c.repo, c.alsoIn])).toEqual([[repoB, [repoA]]]);
  });

  it("takes the repo from git -C when the working directory repo has nothing", async () => {
    const world: World = {
      repos: ["/u", repoA, repoB],
      commits: [{ repo: repoB, n: 1, subject: "x", time: T0 + 11, files: ["x.ts"] }],
    };
    const result = await attributeRequest(
      snapshot({ commands: [command(`git -C ${repoB} commit -q -m x`, "", 10)] }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoB}:x.ts`]);
  });

  it("only takes commits found in all repos when path evidence exists", async () => {
    const world: World = {
      repos: ["/u", repoA, repoB],
      commits: [
        { repo: repoA, n: 1, subject: "mine", time: T0 + 11, files: ["src/mine.ts"] },
        {
          repo: repoB,
          n: 2,
          subject: "someone else",
          time: T0 + 11,
          files: ["theirs.ts", "src/theirs.ts"],
        },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command("git add src/mine.ts theirs.ts && git commit -q -m x", "", 10)],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:src/mine.ts`]);
  });

  it("accepts a root-level file only when the command names the repo", async () => {
    const named = "/u/t3-x-plugin";
    const world: World = {
      repos: ["/u", named, repoB],
      commits: [
        { repo: named, n: 1, subject: "icon", time: T0 + 11, files: ["plugin.json"] },
        { repo: repoB, n: 2, subject: "elsewhere", time: T0 + 11, files: ["plugin.json"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [
          command(
            "for d in t3-x-plugin; do (cd $d && sed -i s/old/new/ plugin.json && git commit -qam x); done",
            "",
            10,
          ),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${named}:plugin.json`]);
  });

  it("ignores a repo name that only appears inside a longer path", async () => {
    const root = "/u/jieyuexing-universe";
    const world: World = {
      repos: [root, repoA],
      commits: [{ repo: root, n: 1, subject: "someone else", time: T0 + 11, files: ["README.md"] }],
    };
    const result = await attributeRequest(
      snapshot({
        threads: [{ threadId: "T", cwd: repoA }],
        commands: [
          command("cd /elsewhere/jieyuexing-universe/projects/y && git commit -q -m x", "", 10),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files).toEqual([]);
  });

  it("follows the directory an earlier command changed into", async () => {
    const world: World = {
      repos: ["/u", repoB],
      commits: [
        { repo: "/u", n: 1, subject: "concurrent", time: T0 + 21, files: ["other.md"] },
        { repo: repoB, n: 2, subject: "mine", time: T0 + 21, files: ["mine.ts"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [
          command(`cd ${repoB} && git status`, "", 10),
          command("git commit -q -am x", "", 20),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoB}:mine.ts`]);
  });

  it("recovers a commit made in a deleted temporary worktree and propagates the evidence repo", async () => {
    const wt = "/u/.local/tmp/job/wt-x";
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "one", time: T0 + 11, files: ["apps/one.ts"] },
        { repo: repoA, n: 2, subject: "two", time: T0 + 21, files: ["apps/two.ts"] },
      ],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [
          command(`cd ${wt} && git add apps/one.ts && git commit -q -m one`, "", 10),
          command(`cd ${wt} && git commit -q -am two`, "", 20),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(paths(result)).toEqual([`${repoA}:apps/one.ts`, `${repoA}:apps/two.ts`]);
  });

  it("merges checkpoint, file change and commit sources for one file", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [{ repo: repoA, n: 1, subject: "x", time: T0 + 11, files: ["x.ts"] }],
    };
    const result = await attributeRequest(
      snapshot({
        threads: [{ threadId: "T", cwd: repoA }],
        commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)],
        fileChanges: [{ threadId: "T", runId: "T:1", path: `${repoA}/x.ts` }],
        checkpoints: [{ threadId: "T", runId: "T:1", files: ["x.ts"] }],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.sources.toSorted()).toEqual(["checkpoint", "fileChange", "output"]);
  });

  it("combines a child's files with the request's checkpoint and tags them", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: Array.from({ length: 13 }, (_, i) => ({
        repo: repoA,
        n: i + 1,
        subject: `c${i}`,
        time: T0 + 11,
        files: [`f${i}.ts`],
      })),
    };
    const result = await attributeRequest(
      snapshot({
        threads: [
          { threadId: "T", cwd: "/u" },
          { threadId: "C", cwd: repoA },
        ],
        subagents: [{ threadId: "T", runId: "T:1", childThreadId: "C" }],
        commands: [
          command(`git -C ${repoA} commit -q -m x`, "", 10, { threadId: "C", runId: null }),
        ],
        checkpoints: [{ threadId: "T", runId: "T:1", files: ["docs/a.md"] }],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files).toHaveLength(14);
    expect(result.files.find((f) => f.path === "docs/a.md")?.sources).toEqual(["checkpoint"]);
    expect(result.files.find((f) => f.path === "f0.ts")?.sources).toEqual(["output", "child"]);
  });

  it("takes items without a run id from folded native child threads", async () => {
    const result = await attributeRequest(
      snapshot({
        threads: [
          { threadId: "T", cwd: "/u" },
          { threadId: "N", cwd: repoA },
        ],
        subagents: [{ threadId: "T", runId: "T:1", childThreadId: "N" }],
        fileChanges: [{ threadId: "N", runId: null, path: `${repoA}/n.ts` }],
      }),
      request,
      fakeGit({ repos: ["/u", repoA] }),
    );
    expect(paths(result)).toEqual([`${repoA}:n.ts`]);
  });

  it("marks a cherry-picked orphan and does not duplicate the file", async () => {
    const world: World = {
      repos: ["/u", repoA],
      commits: [
        { repo: repoA, n: 1, subject: "feat", time: T0 + 11, files: ["x.ts"], orphan: true },
        { repo: repoA, n: 2, subject: "feat", time: T0 + 21, files: ["x.ts"] },
      ],
      mainline: {
        1: {
          byPatchId: info({ repo: repoA, n: 2, subject: "feat", time: T0 + 21, files: [] }),
          sameTitle: [],
        },
      },
    };
    const result = await attributeRequest(
      snapshot({
        commands: [
          command(`git -C ${repoA} commit -q -m feat`, "", 10),
          command(`git -C ${repoA} cherry-pick ${short(1)}`, "", 20),
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.commits).toHaveLength(2);
    expect(result.commits.find((c) => c.orphan)).toMatchObject({
      mergedAs: hex(2),
      mergedVia: "patchId",
    });
  });

  it("infers a merge by unique title with enough file overlap and refuses ambiguous titles", async () => {
    const same = (n: number) => info({ repo: repoA, n, subject: "feat", time: T0 + 99, files: [] });
    const commits: FakeCommit[] = [
      { repo: repoA, n: 1, subject: "feat", time: T0 + 11, files: ["a.ts", "b.ts"], orphan: true },
      { repo: repoA, n: 2, subject: "feat", time: T0 + 99, files: ["a.ts", "b.ts", "c.ts"] },
      { repo: repoA, n: 3, subject: "feat", time: T0 + 98, files: ["a.ts"] },
    ];
    const run = (match: MainlineMatch) =>
      attributeRequest(
        snapshot({ commands: [command(`git -C ${repoA} commit -q -m feat`, "", 10)] }),
        request,
        fakeGit({ repos: ["/u", repoA], commits, mainline: { 1: match } }),
      );
    const inferred = await run({ byPatchId: null, sameTitle: [same(2)] });
    expect(inferred.commits.find((c) => c.orphan)).toMatchObject({ mergedVia: "title" });
    const ambiguous = await run({ byPatchId: null, sameTitle: [same(2), same(3)] });
    expect(ambiguous.commits.find((c) => c.orphan)?.mergedAs).toBeNull();
  });

  it("matches a file change in a deleted temporary worktree by relative path", async () => {
    const wt = "/u/.local/tmp/job/wt-x";
    const world: World = {
      repos: ["/u", repoA],
      commits: [{ repo: repoA, n: 1, subject: "x", time: T0 + 11, files: ["apps/web/a.ts"] }],
    };
    const result = await attributeRequest(
      snapshot({
        commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)],
        fileChanges: [
          { threadId: "T", runId: "T:1", path: `${wt}/apps/web/a.ts` },
          { threadId: "T", runId: "T:1", path: `${wt}/apps/web/gone.ts` },
        ],
      }),
      request,
      fakeGit(world),
    );
    expect(result.files[0]?.sources.toSorted()).toEqual(["fileChange", "output"]);
    expect(result.clearedWorktrees).toBe(1);
  });

  it("lists ignored and out-of-repo file changes as deliverables", async () => {
    const result = await attributeRequest(
      snapshot({
        fileChanges: [
          { threadId: "T", runId: "T:1", path: "/u/.local/tmp/job/plan.md" },
          { threadId: "T", runId: "T:1", path: "/elsewhere/note.md" },
        ],
      }),
      request,
      fakeGit({ repos: ["/u"], ignored: [".local/tmp/job/plan.md"] }),
    );
    expect(result.files).toEqual([]);
    expect(result.deliverables).toEqual(["/elsewhere/note.md", "/u/.local/tmp/job/plan.md"]);
    expect(hasChanges(result)).toBe(true);
  });

  it("reports an empty request as having no changes", async () => {
    const result = await attributeRequest(snapshot(), request, fakeGit({ repos: ["/u"] }));
    expect(hasChanges(result)).toBe(false);
  });

  it("flags output that hit the storage limit", async () => {
    const result = await attributeRequest(
      snapshot({ commands: [command("git log", "x".repeat(1_048_600), 10)] }),
      request,
      fakeGit({ repos: ["/u"] }),
    );
    expect(result.blindSpots).toEqual(["output-truncated"]);
  });

  it("states whether a file is still uncommitted or was committed later", async () => {
    const result = await attributeRequest(
      snapshot({
        fileChanges: [
          { threadId: "T", runId: "T:1", path: `${repoA}/dirty.ts` },
          { threadId: "T", runId: "T:1", path: `${repoA}/later.ts` },
          { threadId: "T", runId: "T:1", path: `${repoA}/lost.ts` },
        ],
      }),
      request,
      fakeGit({ repos: ["/u", repoA], dirty: ["dirty.ts"], later: { "later.ts": hex(9) } }),
    );
    expect(result.files.map((f) => [f.path, f.state])).toEqual([
      ["dirty.ts", { kind: "uncommitted" }],
      ["later.ts", { kind: "committed", hash: hex(9) }],
      ["lost.ts", { kind: "unknown" }],
    ]);
  });

  it("shows at most 500 files and counts the rest", async () => {
    const files = Array.from({ length: 852 }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
    const result = await attributeRequest(
      snapshot({ commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)] }),
      request,
      fakeGit({
        repos: ["/u", repoA],
        commits: [{ repo: repoA, n: 1, subject: "sync", time: T0 + 11, files }],
      }),
    );
    expect(result.files).toHaveLength(500);
    expect(result.omittedFiles).toBe(352);
  });

  it("stops issuing git calls at the budget and says so", async () => {
    const result = await attributeRequest(
      snapshot({ commands: [command(`git -C ${repoA} commit -q -m x`, "", 10)] }),
      request,
      fakeGit({
        repos: ["/u", repoA],
        commits: [{ repo: repoA, n: 1, subject: "x", time: T0 + 11, files: ["x.ts"] }],
      }),
      { gitBudget: 1 },
    );
    expect(result.blindSpots).toContain("git-budget");
    expect(result.gitCalls).toBeLessThanOrEqual(1);
  });
});
