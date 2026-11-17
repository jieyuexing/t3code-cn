import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

// Esc on a run's choices, kept across remounts; run ids derive from thread ids, so the environment is part of the key.
let dismissed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const key = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

export function useChoicesDismissed(environmentId: EnvironmentId, runId: RunId | null): boolean {
  const keys = useSyncExternalStore(subscribe, () => dismissed);
  return runId !== null && keys.has(key(environmentId, runId));
}

export function dismissChoices(environmentId: EnvironmentId, runId: RunId): void {
  dismissed = new Set(dismissed).add(key(environmentId, runId));
  for (const listener of listeners) listener();
}
