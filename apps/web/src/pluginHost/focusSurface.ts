import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { create } from "zustand";

import { resolveFilePreviewPath } from "../components/files/filePreviewMode";
import {
  useRightPanelStore,
  type RightPanelSurface,
  type ThreadRightPanelState,
} from "../rightPanelStore";

type FocusSurface = Extract<RightPanelSurface, { kind: "files" | "file" }>;

/** The file explorer tab, or a file tab that is not a chat attachment (a file tab may hold a folder). */
const isFocusSurface = (surface: RightPanelSurface): surface is FocusSurface =>
  surface.kind === "files" || (surface.kind === "file" && surface.attachment === undefined);

/**
 * Which file or folder tab the thread's panel stands on: the active one, else the one remembered,
 * else (after a reload, or once the remembered tab is closed) the last of those still open.
 */
export function nextFocusSurfaceId(
  previous: string | null,
  state: ThreadRightPanelState | undefined,
): string | null {
  const surfaces = state?.surfaces.filter(isFocusSurface) ?? [];
  const active = surfaces.find((surface) => surface.id === state?.activeSurfaceId);
  if (active) return active.id;
  if (surfaces.some((surface) => surface.id === previous)) return previous;
  return surfaces.at(-1)?.id ?? null;
}

/** Per thread, the id from `nextFocusSurfaceId`; the plugin tab is active when a page reads it. */
export const useFocusSurfaceStore = create<{ byThreadKey: Record<string, string> }>()(() => ({
  byThreadKey: {},
}));

function trackFocusSurfaces(
  byThreadKey: Record<string, ThreadRightPanelState>,
  previousPanels: Record<string, ThreadRightPanelState> | null,
) {
  const current = useFocusSurfaceStore.getState().byThreadKey;
  let next: Record<string, string> | null = null;
  for (const [threadKey, state] of Object.entries(byThreadKey)) {
    if (previousPanels?.[threadKey] === state) continue;
    const id = nextFocusSurfaceId(current[threadKey] ?? null, state);
    if (id === (current[threadKey] ?? null)) continue;
    next ??= { ...current };
    if (id === null) delete next[threadKey];
    else next[threadKey] = id;
  }
  for (const threadKey of Object.keys(current)) {
    if (!(threadKey in byThreadKey)) {
      next ??= { ...current };
      delete next[threadKey];
    }
  }
  if (next !== null) useFocusSurfaceStore.setState({ byThreadKey: next });
}

trackFocusSurfaces(useRightPanelStore.getState().byThreadKey, null);
useRightPanelStore.subscribe((state, previous) =>
  trackFocusSurfaces(state.byThreadKey, previous.byThreadKey),
);

export function useFocusSurface(
  ref: Parameters<typeof scopedThreadKey>[0] | null,
): FocusSurface | null {
  const threadKey = ref === null ? null : scopedThreadKey(ref);
  const id = useFocusSurfaceStore((state) =>
    threadKey === null ? null : (state.byThreadKey[threadKey] ?? null),
  );
  return useRightPanelStore((state) => {
    const surface =
      threadKey === null || id === null
        ? undefined
        : state.byThreadKey[threadKey]?.surfaces.find((entry) => entry.id === id);
    return surface !== undefined && isFocusSurface(surface) ? surface : null;
  });
}

/**
 * Where the tab points: an absolute path, plus the workspace path to ask the server about. That is
 * `null` for the workspace root, which is known to be a folder.
 */
export function focusPathOf(
  surface: FocusSurface,
  cwd: string,
): { path: string; relativePath: string | null } {
  const relativePath =
    surface.kind === "file" ? resolveFilePreviewPath(surface.relativePath, cwd) : null;
  return {
    path: relativePath === null ? cwd : resolvePathLinkTarget(relativePath, cwd),
    relativePath,
  };
}
