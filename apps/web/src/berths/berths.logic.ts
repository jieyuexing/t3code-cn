import { hasUnseenRunFailure } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import {
  isThreadInPlay,
  PENDING_STATUS,
  type PendingThreadShell,
  type PendingThreadStatus,
} from "../pluginHost/pendingThreads";

export const BERTH_COUNT = 6;
/** Slots 0–1 (E1, E2) are permanently reserved for ETECH; 2–5 (03–06) are personal. */
export const ETECH_SLOT_COUNT = 2;
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Six fixed slots by thread id. A slot never shifts to fill another. */
export type Berths = ReadonlyArray<string | null>;

export type BerthShell = PendingThreadShell &
  Pick<
    EnvironmentThreadShell,
    | "createdAt"
    | "updatedAt"
    | "branch"
    | "lastVisitedAt"
    | "latestUserMessageAt"
    | "latestUserAuthoredMessageAt"
  > & {
    readonly source: Pick<
      EnvironmentThreadShell["source"],
      "pendingRuntimeRequest" | "latestVisibleMessage"
    >;
  };

export interface BerthThread {
  readonly threadId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly status: PendingThreadStatus;
  readonly branch: string | null;
  readonly snippet: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface BerthView {
  /** Top-level threads in play, scheduled ones apart, newest activity first. */
  readonly threads: ReadonlyArray<BerthThread>;
  readonly scheduled: ReadonlyArray<BerthThread>;
  /** Live or recent unseen failed subagents under their nearest top-level ancestor. */
  readonly subagents: ReadonlyMap<string, ReadonlyArray<BerthThread>>;
}

// Strict company ticket / system markers only — intentionally excludes broad words like "work" or "141".
const STRICT_ETECH_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:GWH|NSNET|OSN|NCU|CJP)-\d+(?=$|[^A-Za-z0-9])|(?:^|[^A-Za-z0-9])(?:SIR#?\d+|TET|TELIN|CVS)(?=$|[^A-Za-z0-9])/i;

const DATE_PREFIX_PATTERN = /^\d{4}[_-]\s*/;

const STATUS_PRIORITY: Readonly<Record<PendingThreadStatus, number>> = {
  approval: 6,
  failed: 5,
  input: 4,
  request: 3,
  working: 2,
  waiting: 1,
  done: 0,
};

export const emptyBerths = (): Berths => Array.from({ length: BERTH_COUNT }, () => null);

export function slotCode(slot: number): string {
  return slot < ETECH_SLOT_COUNT ? `E${slot + 1}` : `0${slot + 1}`;
}

export function stripDatePrefix(title: string): string {
  const stripped = title.replace(DATE_PREFIX_PATTERN, "").trim();
  return stripped.length > 0 ? stripped : title;
}

export function isNeedsAttention(status: PendingThreadStatus): boolean {
  return status === "approval" || status === "failed" || status === "input" || status === "request";
}

export function isStrictEtechCandidate(thread: Pick<BerthThread, "title" | "branch">): boolean {
  return (
    STRICT_ETECH_PATTERN.test(thread.title) ||
    (thread.branch !== null && STRICT_ETECH_PATTERN.test(thread.branch))
  );
}

function normalizeSnippet(shell: BerthShell): string | null {
  const raw = shell.source.latestVisibleMessage?.text;
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return null;
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
}

function toBerthThread(shell: BerthShell): BerthThread {
  return {
    threadId: shell.id,
    title: shell.title,
    displayTitle: stripDatePrefix(shell.title),
    status: PENDING_STATUS[resolveSidebarThreadStatus(shell)],
    branch: shell.branch,
    snippet: normalizeSnippet(shell),
    updatedAt: shell.updatedAt,
    createdAt: shell.createdAt,
  };
}

/**
 * Only surface a failed subagent from `threadFamilies` when it is still actionable:
 * 1) unseen by the user (`hasUnseenRunFailure`),
 * 2) not superseded by a newer user turn on the parent thread, and
 * 3) within the 24h recency window so long-lived threads never stay stuck red.
 */
function isRelevantSubagent(sub: BerthShell, parent: BerthShell, nowMs: number): boolean {
  const status = PENDING_STATUS[resolveSidebarThreadStatus(sub)];
  if (status === "done") return false;
  if (status !== "failed") return true;

  if (sub.latestRun?.status === "failed") {
    if (!hasUnseenRunFailure(sub)) return false;
  } else if (sub.lastVisitedAt) {
    return false;
  }

  const failedAtIso =
    sub.latestRun?.completedAt ??
    sub.latestRun?.startedAt ??
    sub.latestRun?.requestedAt ??
    sub.updatedAt;
  const failedAtMs = Date.parse(failedAtIso);
  if (!Number.isNaN(failedAtMs)) {
    if (!Number.isNaN(nowMs) && nowMs - failedAtMs > RECENT_FAILURE_WINDOW_MS) return false;
    const parentTurnIso = parent.latestUserAuthoredMessageAt ?? parent.latestUserMessageAt;
    if (parentTurnIso) {
      const parentTurnMs = Date.parse(parentTurnIso);
      if (!Number.isNaN(parentTurnMs) && failedAtMs < parentTurnMs) return false;
    }
  }
  return true;
}

export function effectiveStatus(
  thread: BerthThread,
  subagents: ReadonlyArray<BerthThread>,
): PendingThreadStatus {
  let highest = thread.status;
  for (const child of subagents) {
    if (STATUS_PRIORITY[child.status] > STATUS_PRIORITY[highest]) highest = child.status;
  }
  return highest;
}

export function formatSubagentSummary(subagents: ReadonlyArray<BerthThread>): string | null {
  if (subagents.length === 0) return null;
  let attention = 0;
  let failed = 0;
  let working = 0;
  for (const child of subagents) {
    if (child.status === "failed") failed += 1;
    else if (
      child.status === "approval" ||
      child.status === "input" ||
      child.status === "request"
    ) {
      attention += 1;
    } else if (child.status === "working") {
      working += 1;
    }
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} 失败`);
  if (attention > 0) parts.push(`${attention} 待处理`);
  if (working > 0) parts.push(`${working} 运行`);
  if (parts.length === 0) return `${subagents.length} 子代理`;
  return `${subagents.length} 子代理 · ${parts.join(" · ")}`;
}

const byRecentActivity = (left: BerthThread, right: BerthThread) =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  right.createdAt.localeCompare(left.createdAt) ||
  left.threadId.localeCompare(right.threadId);

const bySubagentUrgency = (left: BerthThread, right: BerthThread) =>
  STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status] || byRecentActivity(left, right);

export function rankCandidates(
  threads: ReadonlyArray<BerthThread>,
  subagents: ReadonlyMap<string, ReadonlyArray<BerthThread>>,
  forEtechSlot: boolean,
): ReadonlyArray<BerthThread> {
  return [...threads].sort((left, right) => {
    if (forEtechSlot) {
      const etechDiff =
        Number(isStrictEtechCandidate(right)) - Number(isStrictEtechCandidate(left));
      if (etechDiff !== 0) return etechDiff;
    }
    const leftUrgent = Number(
      isNeedsAttention(effectiveStatus(left, subagents.get(left.threadId) ?? [])),
    );
    const rightUrgent = Number(
      isNeedsAttention(effectiveStatus(right, subagents.get(right.threadId) ?? [])),
    );
    if (rightUrgent !== leftUrgent) return rightUrgent - leftUrgent;
    return byRecentActivity(left, right);
  });
}

function listedAncestor(
  shell: BerthShell,
  byId: ReadonlyMap<string, BerthShell>,
): BerthShell | null {
  const seen = new Set<string>([shell.id]);
  let current = shell.lineage.parentThreadId;
  while (current !== null && !seen.has(current)) {
    const parent = byId.get(current);
    if (parent === undefined) return null;
    if (parent.lineage.relationshipToParent !== "subagent") return parent;
    seen.add(current);
    current = parent.lineage.parentThreadId;
  }
  return null;
}

export function buildBerthView(input: {
  readonly shells: ReadonlyArray<BerthShell>;
  readonly environmentId: EnvironmentId;
  readonly now: string;
  readonly scheduledThreadIds: ReadonlySet<string>;
}): BerthView {
  const nowMs = Date.parse(input.now);
  const own = input.shells.filter((shell) => shell.environmentId === input.environmentId);
  const byId = new Map<string, BerthShell>(own.map((shell) => [shell.id, shell]));
  const threads: BerthThread[] = [];
  const scheduled: BerthThread[] = [];
  const subagents = new Map<string, BerthThread[]>();
  for (const shell of own) {
    if (isThreadInPlay(shell, input.environmentId, input.now)) {
      (input.scheduledThreadIds.has(shell.id) ? scheduled : threads).push(toBerthThread(shell));
    } else if (
      shell.lineage.relationshipToParent === "subagent" &&
      shell.archivedAt === null &&
      shell.deletedAt === null
    ) {
      const ancestor = listedAncestor(shell, byId);
      if (ancestor !== null && isRelevantSubagent(shell, ancestor, nowMs)) {
        subagents.set(ancestor.id, [...(subagents.get(ancestor.id) ?? []), toBerthThread(shell)]);
      }
    }
  }
  for (const list of subagents.values()) list.sort(bySubagentUrgency);
  return {
    threads: threads.sort(byRecentActivity),
    scheduled: scheduled.sort(byRecentActivity),
    subagents,
  };
}

/** Empties the slots whose thread is no longer in play. Returns the same array when nothing left. */
export function reconcileBerths(berths: Berths, inPlay: ReadonlySet<string>): Berths {
  if (berths.every((id) => id === null || inPlay.has(id))) return berths;
  return berths.map((id) => (id !== null && inPlay.has(id) ? id : null));
}

/** Seats a thread in the given slot, or the first empty one. It leaves any slot it held. */
export function enterBerth(berths: Berths, threadId: string, slot?: number): Berths {
  const target = slot ?? berths.indexOf(null);
  if (target < 0 || target >= BERTH_COUNT) return berths;
  return berths.map((id, index) => (index === target ? threadId : id === threadId ? null : id));
}

export function leaveBerth(berths: Berths, slot: number): Berths {
  return berths.map((id, index) => (index === slot ? null : id));
}
