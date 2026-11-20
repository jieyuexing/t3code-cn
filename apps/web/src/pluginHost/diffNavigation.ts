import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import type { DiffTarget } from "./hostApi";

interface FileReveal {
  readonly filePath: string;
  readonly requestId: number;
  /** The comparison the file was asked for in; the request ends when the panel shows another. */
  readonly scope: string;
}

const scopeOf = (selection: { readonly kind: string; readonly sha?: string }) =>
  selection.kind === "commit" ? `commit:${selection.sha}` : selection.kind;

/** The file a plugin asked the thread's diff panel to bring into view; the panel reads it. */
export const useDiffRevealStore = create<{ byThreadKey: Record<string, FileReveal> }>()(() => ({
  byThreadKey: {},
}));

// A request left standing would expand the file again whenever the user came back to that comparison.
useDiffPanelStore.subscribe((state) => {
  const { byThreadKey } = useDiffRevealStore.getState();
  const stale = Object.entries(byThreadKey).filter(
    ([threadKey, reveal]) =>
      reveal.scope !== scopeOf(state.byThreadKey[threadKey] ?? { kind: "branch" }),
  );
  if (stale.length === 0) return;
  useDiffRevealStore.setState({
    byThreadKey: Object.fromEntries(
      Object.entries(byThreadKey).filter(
        ([threadKey]) => !stale.some(([key]) => key === threadKey),
      ),
    ),
  });
});

export function usePluginDiffReveal(ref: ScopedThreadRef | null | undefined): FileReveal | null {
  return useDiffRevealStore((state) =>
    ref ? (state.byThreadKey[scopedThreadKey(ref)] ?? null) : null,
  );
}

/** Opens T3's own diff panel on the thread, on the uncommitted changes or one commit, at a file. */
export function openThreadDiff(ref: ScopedThreadRef, target: DiffTarget): void {
  const threadKey = scopedThreadKey(ref);
  const diffStore = useDiffPanelStore.getState();
  if (target.kind === "commit" && target.sha !== undefined) {
    diffStore.selectCommit(ref, target.sha);
  } else {
    diffStore.selectGitScope(ref, "unstaged");
  }
  useDiffRevealStore.setState((state) => {
    const { [threadKey]: previous, ...rest } = state.byThreadKey;
    return {
      byThreadKey:
        target.file === undefined
          ? rest
          : {
              ...rest,
              [threadKey]: {
                filePath: target.file,
                requestId: (previous?.requestId ?? 0) + 1,
                scope: scopeOf(
                  useDiffPanelStore.getState().byThreadKey[threadKey] ?? { kind: "branch" },
                ),
              },
            },
    };
  });
  useRightPanelStore.getState().open(ref, "diff");
}
