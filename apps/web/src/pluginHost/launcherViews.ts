import type { ScopedThreadRef } from "@t3tools/contracts";
import type { PluginHostSnapshot, PluginHostView } from "@t3tools/contracts";

import { useRightPanelStore } from "../rightPanelStore";

/** The views a launcher lists, in the host's order: none while the host is off or the snapshot is unknown. */
export function launcherViews(
  snapshot: PluginHostSnapshot | null,
  canCall: boolean,
): ReadonlyArray<PluginHostView> {
  return snapshot !== null && snapshot.hostEnabled && canCall ? snapshot.views : [];
}

/** Opens a plugin view as a tab of the thread's right panel; the palette and both panel launchers share it. */
export function openPluginView(ref: ScopedThreadRef, view: PluginHostView) {
  useRightPanelStore.getState().openPlugin(ref, {
    kind: "plugin",
    pluginId: view.pluginId,
    viewId: view.viewId,
    title: view.title,
  });
}
