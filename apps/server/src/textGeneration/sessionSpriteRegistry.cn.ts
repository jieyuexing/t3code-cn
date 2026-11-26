import type { RunId, ThreadId } from "@t3tools/contracts";

export interface SessionSpriteAdvisorSnapshot {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly encoded: string;
  readonly hasExplicitChoices: boolean;
  readonly lastReplyExcerpt: string;
  readonly sampledAt: number;
  readonly scheduledTaskId?: string | undefined;
}

const MAX_SNAPSHOTS = 128;
const snapshots = new Map<ThreadId, SessionSpriteAdvisorSnapshot>();

/** Keeps the latest advisor snapshot per thread in an insertion-ordered LRU map (cap 128). */
export function recordAdvisorSnapshot(snapshot: SessionSpriteAdvisorSnapshot): void {
  snapshots.delete(snapshot.threadId);
  snapshots.set(snapshot.threadId, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function clearAdvisorSnapshot(threadId: ThreadId): void {
  snapshots.delete(threadId);
}

/** Returns snapshots from most recently sampled to oldest. */
export function listAdvisorSnapshots(): ReadonlyArray<SessionSpriteAdvisorSnapshot> {
  return [...snapshots.values()].toReversed();
}

export function resetAdvisorSnapshotsForTest(): void {
  snapshots.clear();
}
