import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useRightPanelStore, type ThreadRightPanelState } from "../rightPanelStore";
import { pluginHostEnvironment } from "./state";

type ByThreadKey = Record<string, ThreadRightPanelState>;

/** Drops plugin tabs of one environment whose view is not in `availableSurfaceIds`. */
export function prunePluginSurfaces(
  byThreadKey: ByThreadKey,
  environmentId: EnvironmentId,
  availableSurfaceIds: ReadonlySet<string>,
): ByThreadKey {
  let next: ByThreadKey | null = null;
  for (const [threadKey, current] of Object.entries(byThreadKey)) {
    if (parseScopedThreadKey(threadKey)?.environmentId !== environmentId) continue;
    const surfaces = current.surfaces.filter(
      (surface) => surface.kind !== "plugin" || availableSurfaceIds.has(surface.id),
    );
    if (surfaces.length === current.surfaces.length) continue;
    const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
    next ??= { ...byThreadKey };
    next[threadKey] = {
      ...current,
      isOpen: surfaces.length > 0 ? current.isOpen : false,
      surfaces,
      activeSurfaceId: activeStillExists ? current.activeSurfaceId : (surfaces.at(-1)?.id ?? null),
    };
  }
  return next ?? byThreadKey;
}

/**
 * Plugin tabs outlive a restart in the persisted panel state. Once an environment reports its
 * plugins for the first time, tabs whose view is gone are removed; after that a vanished view
 * shows as unavailable instead. Environments without plugin tabs are never subscribed.
 */
export function startPluginSurfacePruning(): void {
  const environmentIds = new Set<EnvironmentId>();
  for (const [threadKey, state] of Object.entries(useRightPanelStore.getState().byThreadKey)) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref !== null && state.surfaces.some((surface) => surface.kind === "plugin")) {
      environmentIds.add(ref.environmentId);
    }
  }
  for (const environmentId of environmentIds) {
    const atom = pluginHostEnvironment.snapshot({ environmentId, input: {} });
    const unsubscribe = appAtomRegistry.subscribe(atom, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      unsubscribe();
      const available = new Set(
        result.value.views.map((view) => `plugin:${view.pluginId}:${view.viewId}`),
      );
      useRightPanelStore.setState((state) => ({
        byThreadKey: prunePluginSurfaces(state.byThreadKey, environmentId, available),
      }));
    });
  }
}
