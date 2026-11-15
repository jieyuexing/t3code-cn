import type { ScopedThreadRef } from "@t3tools/contracts";

import { usePluginHostSnapshot } from "../usePluginHost";
import { railOf } from "./rail.logic";

/** Whether the app rail is on screen for this thread; `null` stands for a view that shows no rail. */
export function useAppRailVisible(threadRef: ScopedThreadRef | null): boolean {
  const { snapshot } = usePluginHostSnapshot(threadRef?.environmentId ?? null);
  return threadRef !== null && railOf(snapshot).enabled;
}
