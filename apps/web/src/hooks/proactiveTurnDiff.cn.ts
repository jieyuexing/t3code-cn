import type { RunId } from "@t3tools/contracts";

import { shouldOpenProactiveTurnDiff } from "../components/ChatView.logic";

/**
 * A completed turn whose awaited background work still runs is not done yet, so its diff waits
 * and keeps the remembered running turn for the pass that finds the work finished.
 */
export function observeProactiveTurnDiff(input: {
  previousRunningTurnId: RunId | null | undefined;
  runningTurnId: RunId | null;
  settledTurnId: RunId | null;
  turnCompleted: boolean;
  backgroundWorkHolds: boolean;
}): { newlyCompletedTurnId: RunId | null; nextRunningTurnId: RunId | null | undefined } {
  const completed = shouldOpenProactiveTurnDiff(input) ? input.settledTurnId : null;
  return completed !== null && input.backgroundWorkHolds
    ? { newlyCompletedTurnId: null, nextRunningTurnId: input.previousRunningTurnId }
    : { newlyCompletedTurnId: completed, nextRunningTurnId: input.runningTurnId };
}
