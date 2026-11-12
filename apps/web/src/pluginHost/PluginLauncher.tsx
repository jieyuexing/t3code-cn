import type { PluginHostView, ScopedThreadRef } from "@t3tools/contracts";
import { PuzzleIcon } from "lucide-react";

import { MenuItem } from "../components/ui/menu";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { launcherViews, openPluginView } from "./launcherViews";
import { useCanCallPluginHost, usePluginHostSnapshot } from "./usePluginHost";

/** The open thread's views from its environment's plugin snapshot; nothing without a thread. */
function useLauncherViews(): {
  readonly ref: ScopedThreadRef | null;
  readonly views: ReadonlyArray<PluginHostView>;
} {
  const ref = useThreadRouteRef();
  const environmentId = ref?.environmentId ?? null;
  const { snapshot } = usePluginHostSnapshot(environmentId);
  const canCall = useCanCallPluginHost(environmentId);
  return { ref, views: ref === null ? [] : launcherViews(snapshot, canCall) };
}

const viewKey = (view: PluginHostView) => `${view.pluginId}:${view.viewId}`;

/** Plugin views as rows under the right panel's "Open a surface" list; they have no shortcut. */
export function PluginLauncherRows() {
  const { ref, views } = useLauncherViews();
  if (ref === null) return null;
  return views.map((view) => (
    <button
      key={viewKey(view)}
      type="button"
      onClick={() => openPluginView(ref, view)}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors hover:bg-accent/60"
    >
      <PuzzleIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{view.title}</span>
    </button>
  ));
}

/** Plugin views as items at the end of the right panel's "+" menu. */
export function PluginLauncherMenuItems() {
  const { ref, views } = useLauncherViews();
  if (ref === null) return null;
  return views.map((view) => (
    <MenuItem key={viewKey(view)} onClick={() => openPluginView(ref, view)}>
      <PuzzleIcon />
      {view.title}
    </MenuItem>
  ));
}
