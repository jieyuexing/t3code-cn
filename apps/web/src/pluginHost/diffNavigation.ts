import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useDiffPanelStore } from "../diffPanelStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import type { DiffTarget } from "./hostApi";

interface FileReveal {
  readonly filePath: string;
  readonly requestId: number;
}

/** The file a plugin asked the thread's diff panel to bring into view; the panel reads it. */
export const useDiffRevealStore = create<{ byThreadKey: Record<string, FileReveal> }>()(() => ({
  byThreadKey: {},
}));

export function usePluginDiffReveal(ref: ScopedThreadRef | null | undefined): FileReveal | null {
  return useDiffRevealStore((state) =>
    ref ? (state.byThreadKey[scopedThreadKey(ref)] ?? null) : null,
  );
}

/** Opens T3's own diff panel on the thread, on the uncommitted changes or one commit, at a file. */
export function openThreadDiff(ref: ScopedThreadRef, target: DiffTarget): void {
  const threadKey = scopedThreadKey(ref);
  const diffOpen =
    selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, ref) === "diff";
  const diffStore = useDiffPanelStore.getState();
  if (target.kind === "commit" && target.sha !== undefined) {
    diffStore.selectCommit(ref, target.sha, !diffOpen);
  } else {
    diffStore.selectGitScope(ref, "unstaged");
    // Opening a closed panel otherwise resets it to the branch comparison.
    if (!diffOpen) useDiffPanelStore.setState({ keepSelectionOnOpenThreadKey: threadKey });
  }
  useDiffRevealStore.setState((state) => {
    const { [threadKey]: previous, ...rest } = state.byThreadKey;
    return {
      byThreadKey:
        target.file === undefined
          ? rest
          : {
              ...rest,
              [threadKey]: { filePath: target.file, requestId: (previous?.requestId ?? 0) + 1 },
            },
    };
  });
  useRightPanelStore.getState().open(ref, "diff");
}
