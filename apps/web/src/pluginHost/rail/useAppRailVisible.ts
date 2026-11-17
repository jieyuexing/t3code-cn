import type { ScopedThreadRef } from "@t3tools/contracts";

import { usePluginHostSnapshot } from "../usePluginHost";
import { railOf } from "./rail.logic";

/** Whether the app rail is on screen for this thread; `null` stands for a view that shows no rail. */
export function useAppRailVisible(threadRef: ScopedThreadRef | null): boolean {
  const { snapshot } = usePluginHostSnapshot(threadRef?.environmentId ?? null);
  return threadRef !== null && railOf(snapshot).enabled;
}

/**
 * Wraps the window's top-right titlebar controls while the rail is on screen: they are fixed to
 * the window edge, so without it the maximize toggle lands inside the rail column.
 */
export const RAIL_TITLEBAR_OFFSET_CLASS =
  "contents [&>[data-workspace-titlebar-controls]]:mr-[calc(--spacing(10)+1px)]";
