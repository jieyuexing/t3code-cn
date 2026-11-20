import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { focusPathOf, nextFocusSurfaceId, useFocusSurfaceStore } from "./focusSurface";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const view = { kind: "plugin" as const, pluginId: "example.vcs", viewId: "vcs", title: "VCS" };

const panel = () => useRightPanelStore.getState();
const focusId = (target = ref) =>
  useFocusSurfaceStore.getState().byThreadKey[scopedThreadKey(target)] ?? null;

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useFocusSurfaceStore.setState({ byThreadKey: {} });
});

describe("the remembered file or folder tab", () => {
  it("follows the last activated file tab, through the plugin tab being active", () => {
    panel().openFile(ref, "src/a.ts");
    expect(focusId()).toBe("file:src/a.ts");
    panel().openFile(ref, "projects/b");
    expect(focusId()).toBe("file:projects/b");

    panel().openPlugin(ref, view);
    expect(panel().byThreadKey[scopedThreadKey(ref)]!.activeSurfaceId).toBe(
      "plugin:example.vcs:vcs",
    );
    expect(focusId()).toBe("file:projects/b");

    panel().activateSurface(ref, "file:src/a.ts");
    panel().openPlugin(ref, view);
    expect(focusId()).toBe("file:src/a.ts");
  });

  it("takes the new id when a folder navigation replaces the tab in place, and the root tab for the workspace root", () => {
    panel().openFile(ref, "projects/a/x.ts");
    panel().navigateFolder(ref, "file:projects/a/x.ts", "projects/a", "projects/a/x.ts");
    expect(focusId()).toBe("file:projects/a");
    panel().navigateFolder(ref, "file:projects/a", "", "projects/a");
    expect(focusId()).toBe("files");
  });

  it("ignores chat attachments and keeps the threads apart", () => {
    panel().openFile(ref, "a.ts");
    panel().openAttachment(ref, {
      id: "att-1",
      name: "notes.txt",
    } as Parameters<ReturnType<typeof panel>["openAttachment"]>[1]);
    expect(focusId()).toBe("file:a.ts");
    expect(focusId(other)).toBeNull();
  });

  it("falls back to the last file tab still open when the remembered one is closed, and to none", () => {
    panel().openFile(ref, "a.ts");
    panel().openFile(ref, "b.ts");
    panel().openFile(ref, "c.ts");
    panel().openPlugin(ref, view);
    panel().closeSurface(ref, "file:c.ts");
    expect(focusId()).toBe("file:b.ts");
    panel().closeSurface(ref, "file:a.ts");
    panel().closeSurface(ref, "file:b.ts");
    expect(focusId()).toBeNull();
  });
});

describe("nextFocusSurfaceId", () => {
  const surfaces: RightPanelSurface[] = [
    {
      id: "file:old.ts",
      kind: "file",
      relativePath: "old.ts",
      revealLine: null,
      revealRequestId: 1,
    },
    {
      id: "file:new.ts",
      kind: "file",
      relativePath: "new.ts",
      revealLine: null,
      revealRequestId: 1,
    },
    { id: "plugin:p:v", kind: "plugin", pluginId: "p", viewId: "v", title: "V" },
  ];

  it("after a reload, with only persisted state and the plugin tab active, picks the last file tab", () => {
    expect(
      nextFocusSurfaceId(null, { isOpen: true, activeSurfaceId: "plugin:p:v", surfaces }),
    ).toBe("file:new.ts");
  });

  it("keeps the remembered tab over a later one while a non-file tab is active", () => {
    expect(
      nextFocusSurfaceId("file:old.ts", { isOpen: true, activeSurfaceId: "plugin:p:v", surfaces }),
    ).toBe("file:old.ts");
  });
});

describe("focusPathOf", () => {
  it("is the workspace root for the root tab and for a path that resolves to the root", () => {
    expect(focusPathOf({ id: "files", kind: "files" }, "/w")).toEqual({
      path: "/w",
      relativePath: null,
    });
    expect(
      focusPathOf(
        { id: "file:.", kind: "file", relativePath: ".", revealLine: null, revealRequestId: 0 },
        "/w",
      ),
    ).toEqual({ path: "/w", relativePath: null });
  });

  it("is the absolute path for a workspace-relative or an absolute host path", () => {
    const file = (relativePath: string): Extract<RightPanelSurface, { kind: "file" }> => ({
      id: `file:${relativePath}`,
      kind: "file",
      relativePath,
      revealLine: null,
      revealRequestId: 0,
    });
    expect(focusPathOf(file("projects/a/x.ts"), "/w")).toEqual({
      path: "/w/projects/a/x.ts",
      relativePath: "projects/a/x.ts",
    });
    expect(focusPathOf(file("/elsewhere/y.ts"), "/w")).toEqual({
      path: "/elsewhere/y.ts",
      relativePath: "/elsewhere/y.ts",
    });
  });
});
