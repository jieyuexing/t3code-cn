import type { OrchestrationV2PlanArtifact, OrchestrationV2RunStatus } from "@t3tools/contracts";

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;
export type PlanStep = TodoListPlan["steps"][number];

/** The parts of a thread's structure that decide which plan is the current one. */
export interface ThreadPlanSource {
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly status: OrchestrationV2RunStatus;
  }>;
  readonly turnItems: ReadonlyArray<{
    readonly type: string;
    readonly ordinal: number;
    readonly planId?: string;
  }>;
}

export interface SelectedThreadPlan {
  readonly plan: TodoListPlan;
  /** The plan's run is still working, so its running step has a meaningful elapsed time. */
  readonly live: boolean;
}

const LIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * The thread's newest todo list. Plan ids are random, so the newest is the one in the latest run,
 * then the one its latest todo item belongs to; array order only breaks the remaining ties.
 * A superseded plan was replaced by a newer one, so it never counts.
 */
export function selectThreadPlan(source: ThreadPlanSource): SelectedThreadPlan | null {
  const runOrdinals = new Map(source.runs.map((run) => [run.id, run.ordinal] as const));
  const itemOrdinals = new Map<string, number>();
  for (const item of source.turnItems) {
    if (item.type !== "todo_list" || item.planId === undefined) continue;
    itemOrdinals.set(item.planId, Math.max(itemOrdinals.get(item.planId) ?? -1, item.ordinal));
  }
  let latest: TodoListPlan | null = null;
  let latestRank: readonly [number, number] = [-1, -1];
  for (const plan of source.plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded") continue;
    const rank = [
      plan.runId === null ? -1 : (runOrdinals.get(plan.runId) ?? -1),
      itemOrdinals.get(plan.id) ?? -1,
    ] as const;
    if (
      latest === null ||
      rank[0] > latestRank[0] ||
      (rank[0] === latestRank[0] && rank[1] >= latestRank[1])
    ) {
      latest = plan;
      latestRank = rank;
    }
  }
  if (latest === null || latest.steps.length === 0) return null;
  const run = latest.runId === null ? undefined : source.runs.find((r) => r.id === latest.runId);
  return { plan: latest, live: run !== undefined && LIVE_RUN_STATUSES.has(run.status) };
}

export interface PlanGroups {
  readonly done: ReadonlyArray<PlanStep>;
  readonly running: ReadonlyArray<PlanStep>;
  readonly pending: ReadonlyArray<PlanStep>;
  /** What the plan is on now: a running step, else the next pending one. */
  readonly current: PlanStep | null;
}

export function groupPlanSteps(steps: ReadonlyArray<PlanStep>): PlanGroups {
  const done = steps.filter((step) => step.status === "completed");
  const running = steps.filter((step) => step.status === "running");
  const pending = steps.filter((step) => step.status === "pending");
  return { done, running, pending, current: running[0] ?? pending[0] ?? null };
}

/** Claude marks a finished list completed; Codex leaves it active, so the steps decide too. */
export function isPlanComplete(plan: TodoListPlan): boolean {
  return plan.status === "completed" || plan.steps.every((step) => step.status === "completed");
}

export interface ThreadPlanProgress {
  readonly done: number;
  readonly total: number;
  readonly complete: boolean;
  readonly currentStep: string | null;
}

export function planProgress(plan: TodoListPlan): ThreadPlanProgress {
  const { done, current } = groupPlanSteps(plan.steps);
  return {
    done: done.length,
    total: plan.steps.length,
    complete: isPlanComplete(plan),
    currentStep: current?.text ?? null,
  };
}

export type PlanDensity = "full" | "compact" | "essential";

/** Which rows of the Plan block each card density keeps. */
export function planRows(density: PlanDensity) {
  return {
    bar: density === "full",
    current: density !== "essential",
    lists: density === "full",
  };
}

/** Pending steps listed before "+N more". */
const PLAN_PENDING_PREVIEW_COUNT = 5;

export function previewPendingSteps(pending: ReadonlyArray<PlanStep>, expanded: boolean) {
  const shown = expanded ? pending : pending.slice(0, PLAN_PENDING_PREVIEW_COUNT);
  return { shown, hidden: pending.length - shown.length };
}

/** Minute granularity; the card re-renders once a minute, not every second. */
export function formatPlanElapsed(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "<1m";
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
