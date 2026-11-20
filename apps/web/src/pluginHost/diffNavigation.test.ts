import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { openThreadDiff, useDiffRevealStore } from "./diffNavigation";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useDiffPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useDiffRevealStore.setState({ byThreadKey: {} });
});

const selection = (target: typeof ref) =>
  selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, target);
const activePanel = (target: typeof ref) =>
  selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, target);

describe("openThreadDiff", () => {
  it("opens the closed diff panel on a commit", () => {
    openThreadDiff(ref, { kind: "commit", sha: "abc1234" });
    expect(selection(ref)).toMatchObject({ kind: "commit", sha: "abc1234" });
    expect(activePanel(ref)).toBe("diff");
    expect(selection(other)).toMatchObject({ kind: "branch" });
  });

  it("opens the closed diff panel on the uncommitted changes", () => {
    openThreadDiff(ref, { kind: "working-tree" });
    expect(selection(ref)).toEqual({ kind: "unstaged" });
    expect(activePanel(ref)).toBe("diff");
  });

  it("asks the panel to reveal the named file, again for each request", () => {
    openThreadDiff(ref, { kind: "working-tree", file: "src/a.ts" });
    const first = useDiffRevealStore.getState().byThreadKey[scopedThreadKey(ref)];
    expect(first).toMatchObject({ filePath: "src/a.ts" });
    openThreadDiff(ref, { kind: "working-tree", file: "src/a.ts" });
    const second = useDiffRevealStore.getState().byThreadKey[scopedThreadKey(ref)];
    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0);
    openThreadDiff(ref, { kind: "working-tree" });
    expect(useDiffRevealStore.getState().byThreadKey[scopedThreadKey(ref)]).toBeUndefined();
  });

  it("forgets a requested file once the user moves the panel to another comparison", () => {
    const key = scopedThreadKey(ref);
    openThreadDiff(ref, { kind: "commit", sha: "abc1234", file: "src/a.ts" });
    expect(useDiffRevealStore.getState().byThreadKey[key]).toMatchObject({ filePath: "src/a.ts" });
    // The same comparison chosen again keeps the request; a different one drops it.
    useDiffPanelStore.getState().selectCommit(ref, "abc1234");
    expect(useDiffRevealStore.getState().byThreadKey[key]).toBeDefined();
    useDiffPanelStore.getState().selectGitScope(ref, "branch");
    expect(useDiffRevealStore.getState().byThreadKey[key]).toBeUndefined();
    useDiffPanelStore.getState().selectGitScope(ref, "unstaged");
    expect(useDiffRevealStore.getState().byThreadKey[key]).toBeUndefined();

    openThreadDiff(ref, { kind: "working-tree", file: "src/b.ts" });
    useDiffPanelStore.getState().selectCommit(ref, "def5678");
    expect(useDiffRevealStore.getState().byThreadKey[key]).toBeUndefined();
  });
});
