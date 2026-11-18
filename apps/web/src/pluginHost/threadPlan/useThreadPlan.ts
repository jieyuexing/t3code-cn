import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { planProgress, selectThreadPlan } from "./threadPlan.logic";

/** The thread's newest todo list; rides the thread structure the chat view already subscribes to. */
export function useThreadPlan(threadRef: ScopedThreadRef | null) {
  // A draft has no shell yet; reading its detail would probe the server and 404 until the first send.
  const shell = useQuietThreadShell(threadRef);
  const projection =
    useQuietThreadProjection(shell === null ? null : threadRef)?.projection ?? null;
  return projection === null ? null : selectThreadPlan(projection);
}

/** Done and total steps with the current one, or null while the thread has no plan. */
export function useThreadPlanProgress(threadRef: ScopedThreadRef | null) {
  const selected = useThreadPlan(threadRef);
  return selected === null ? null : planProgress(selected);
}
