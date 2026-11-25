import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import {
  isThreadInPlay,
  PENDING_STATUS,
  type PendingThreadShell,
  type PendingThreadStatus,
} from "../pluginHost/pendingThreads";

export const BERTH_COUNT = 6;
export const PRIMARY_BERTH_COUNT = 2;

/** Six slots by thread id; the first two are the primary berths. A slot never shifts to fill another. */
export type Berths = ReadonlyArray<string | null>;

/** User overrides for whether a thread belongs to the top ETECH priority lane. */
export type EtechOverrides = Readonly<Record<string, boolean>>;

export type VisualSeverity = "critical" | "attention" | "active" | "quiet";

export type BerthShell = PendingThreadShell &
  Pick<EnvironmentThreadShell, "createdAt" | "modelSelection" | "branch">;

export interface BerthThread {
  readonly threadId: string;
  readonly title: string;
  readonly status: PendingThreadStatus;
  readonly model: string;
  readonly branch: string | null;
  readonly createdAt: string;
}

export interface BerthView {
  /** Top-level threads in play, scheduled ones apart. */
  readonly threads: ReadonlyArray<BerthThread>;
  readonly scheduled: ReadonlyArray<BerthThread>;
  /** Subagents by their nearest top-level ancestor, oldest first. */
  readonly subagents: ReadonlyMap<string, ReadonlyArray<BerthThread>>;
}

const ETECH_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:GWH|NSNET|OSN|NCU|CJP)(?:-\d+)?(?=$|[^A-Za-z0-9])|(?:^|[^A-Za-z0-9])(?:SIR|TET|TELIN|etech|work|141)(?=$|[^A-Za-z0-9])/i;

const SEVERITY_RANK: Readonly<Record<VisualSeverity, number>> = {
  critical: 3,
  attention: 2,
  active: 1,
  quiet: 0,
};

export const emptyBerths = (): Berths => Array.from({ length: BERTH_COUNT }, () => null);

function statusSeverity(status: PendingThreadStatus): VisualSeverity {
  if (status === "approval" || status === "failed") return "critical";
  if (status === "input" || status === "request") return "attention";
  if (status === "working") return "active";
  return "quiet";
}

export function effectiveSeverity(
  thread: BerthThread,
  subagents: ReadonlyArray<BerthThread>,
): VisualSeverity {
  let highest = statusSeverity(thread.status);
  for (const child of subagents) {
    const childSeverity = statusSeverity(child.status);
    if (SEVERITY_RANK[childSeverity] > SEVERITY_RANK[highest]) highest = childSeverity;
  }
  return highest;
}

export function isEtechThread(
  thread: Pick<BerthThread, "threadId" | "title" | "branch">,
  overrides: EtechOverrides = {},
): boolean {
  const override = overrides[thread.threadId];
  if (override !== undefined) return override;
  return (
    ETECH_PATTERN.test(thread.title) ||
    (thread.branch !== null && ETECH_PATTERN.test(thread.branch))
  );
}

function toBerthThread(shell: BerthShell): BerthThread {
  return {
    threadId: shell.id,
    title: shell.title,
    status: PENDING_STATUS[resolveSidebarThreadStatus(shell)],
    model: shell.modelSelection.model.split("/").at(-1) ?? shell.modelSelection.model,
    branch: shell.branch,
    createdAt: shell.createdAt,
  };
}

const byCreation = (left: BerthThread, right: BerthThread) =>
  left.createdAt.localeCompare(right.createdAt) || left.threadId.localeCompare(right.threadId);

function sortThreadsByPriority(
  threads: ReadonlyArray<BerthThread>,
  subagents: ReadonlyMap<string, ReadonlyArray<BerthThread>>,
): ReadonlyArray<BerthThread> {
  return [...threads].sort((left, right) => {
    const leftRank = SEVERITY_RANK[effectiveSeverity(left, subagents.get(left.threadId) ?? [])];
    const rightRank = SEVERITY_RANK[effectiveSeverity(right, subagents.get(right.threadId) ?? [])];
    return rightRank - leftRank || byCreation(left, right);
  });
}

export function partitionBerthThreads(
  threads: ReadonlyArray<BerthThread>,
  subagents: ReadonlyMap<string, ReadonlyArray<BerthThread>>,
  overrides: EtechOverrides = {},
): {
  readonly etech: ReadonlyArray<BerthThread>;
  readonly personal: ReadonlyArray<BerthThread>;
} {
  const etech: BerthThread[] = [];
  const personal: BerthThread[] = [];
  for (const thread of threads) {
    (isEtechThread(thread, overrides) ? etech : personal).push(thread);
  }
  return {
    etech: sortThreadsByPriority(etech, subagents),
    personal: sortThreadsByPriority(personal, subagents),
  };
}

function listedAncestorId(shell: BerthShell, byId: ReadonlyMap<string, BerthShell>): string | null {
  const seen = new Set<string>([shell.id]);
  let current = shell.lineage.parentThreadId;
  while (current !== null && !seen.has(current)) {
    const parent = byId.get(current);
    if (parent === undefined) return null;
    if (parent.lineage.relationshipToParent !== "subagent") return parent.id;
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
      const ancestor = listedAncestorId(shell, byId);
      if (ancestor !== null) {
        subagents.set(ancestor, [...(subagents.get(ancestor) ?? []), toBerthThread(shell)]);
      }
    }
  }
  for (const list of subagents.values()) list.sort(byCreation);
  return { threads: threads.sort(byCreation), scheduled: scheduled.sort(byCreation), subagents };
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
