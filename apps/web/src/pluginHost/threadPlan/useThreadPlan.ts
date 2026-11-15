import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadProjection } from "~/state/entities";
import { planProgress, selectThreadPlan } from "./threadPlan.logic";

/** The thread's newest todo list; rides the thread structure the chat view already subscribes to. */
export function useThreadPlan(threadRef: ScopedThreadRef | null) {
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  return projection === null ? null : selectThreadPlan(projection);
}

/** Done and total steps with the current one, or null while the thread has no plan. */
export function useThreadPlanProgress(threadRef: ScopedThreadRef | null) {
  const plan = useThreadPlan(threadRef)?.plan ?? null;
  return plan === null ? null : planProgress(plan);
}
