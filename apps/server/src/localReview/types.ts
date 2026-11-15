export interface RunCause {
  readonly createdBy: string;
  readonly delegatedParentRunId: string | null;
  readonly backgroundNotification: boolean;
}

export interface SnapshotRun {
  readonly runId: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly requestedAt: number;
  readonly completedAt: number | null;
  readonly cause: RunCause;
}

export interface SnapshotThread {
  readonly threadId: string;
  readonly cwd: string | null;
}

export interface SnapshotSubagent {
  readonly threadId: string;
  readonly runId: string | null;
  readonly childThreadId: string | null;
}

export interface SnapshotCommand {
  readonly threadId: string;
  readonly runId: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly input: string;
  readonly output: string;
}

export interface SnapshotFileChange {
  readonly threadId: string;
  readonly runId: string | null;
  readonly path: string;
}

export interface SnapshotCheckpoint {
  readonly threadId: string;
  readonly runId: string;
  readonly files: ReadonlyArray<string>;
}

export interface Snapshot {
  readonly runs: ReadonlyArray<SnapshotRun>;
  readonly threads: ReadonlyArray<SnapshotThread>;
  readonly subagents: ReadonlyArray<SnapshotSubagent>;
  readonly commands: ReadonlyArray<SnapshotCommand>;
  readonly fileChanges: ReadonlyArray<SnapshotFileChange>;
  readonly checkpoints: ReadonlyArray<SnapshotCheckpoint>;
}

export interface Request {
  readonly id: string;
  readonly threadId: string;
  readonly runIds: ReadonlyArray<string>;
  readonly origin: "user" | "agent";
  readonly startedAt: number;
  readonly endedAt: number;
  readonly running: boolean;
}

export interface Scope {
  readonly threadId: string;
  readonly runIds: ReadonlySet<string> | null;
}

export interface CommitInfo {
  readonly hash: string;
  readonly subject: string;
  readonly time: number;
  readonly parents: ReadonlyArray<string>;
}

export interface RepoRef {
  readonly workDir: string;
  readonly root: string;
}

export interface MainlineMatch {
  readonly byPatchId: CommitInfo | null;
  readonly sameTitle: ReadonlyArray<CommitInfo>;
}

export interface GitFacts {
  readonly discoverRepos: () => Promise<ReadonlyArray<string>>;
  readonly repoOf: (path: string) => Promise<RepoRef | null>;
  readonly commitsInSpan: (
    repo: string,
    sinceSec: number,
    untilSec: number,
  ) => Promise<ReadonlyArray<CommitInfo>>;
  readonly resolveCommits: (
    repo: string,
    tokens: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<CommitInfo>>;
  readonly commitsInRange: (
    repo: string,
    from: string,
    to: string,
  ) => Promise<ReadonlyArray<CommitInfo>>;
  readonly changedFiles: (repo: string, hash: string) => Promise<ReadonlyArray<string>>;
  readonly isReachable: (repo: string, hash: string) => Promise<boolean>;
  readonly mainlineMatch: (repo: string, commit: CommitInfo) => Promise<MainlineMatch>;
  readonly dirtyFiles: (workDir: string) => Promise<ReadonlySet<string>>;
  readonly ignoredFiles: (
    workDir: string,
    paths: ReadonlyArray<string>,
  ) => Promise<ReadonlySet<string>>;
  readonly lastCommitTouching: (
    repo: string,
    sinceSec: number,
    paths: ReadonlyArray<string>,
  ) => Promise<ReadonlyMap<string, string>>;
  readonly callCount: () => number;
}

export type SourceLayer = "checkpoint" | "fileChange" | "output" | "range" | "child";

export type FileState =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "committed"; readonly hash: string }
  | { readonly kind: "unknown" };

export type CommitRole = "output" | "range";

export interface RequestCommit {
  readonly repo: string;
  readonly hash: string;
  readonly subject: string;
  readonly time: number;
  readonly role: CommitRole;
  readonly orphan: boolean;
  readonly mergedAs: string | null;
  readonly mergedVia: "patchId" | "title" | null;
  readonly alsoIn: ReadonlyArray<string>;
  readonly fromChild: boolean;
}

export interface RequestFile {
  readonly repo: string;
  readonly path: string;
  readonly sources: ReadonlyArray<SourceLayer>;
  readonly commits: ReadonlyArray<string>;
  readonly state: FileState;
}

export type BlindSpot = "output-truncated" | "git-budget";

export interface RequestFiles {
  readonly files: ReadonlyArray<RequestFile>;
  readonly commits: ReadonlyArray<RequestCommit>;
  readonly deliverables: ReadonlyArray<string>;
  readonly mentionedCommits: number;
  readonly clearedWorktrees: number;
  readonly omittedFiles: number;
  readonly blindSpots: ReadonlyArray<BlindSpot>;
  readonly gitCalls: number;
}
