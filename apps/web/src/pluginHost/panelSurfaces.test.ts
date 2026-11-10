import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "../closedViewStore";
import { reopenClosedView } from "../reopenClosedView";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { prunePluginSurfaces } from "./pruneSurfaces";

const environmentId = EnvironmentId.make("env-1");
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-A"));
const otherEnvironmentRef = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("thread-A"));
const clock = { pluginId: "example.echo-clock", viewId: "clock", title: "Echo Clock" };
const notes = { pluginId: "example.notes", viewId: "notes", title: "Notes" };

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("plugin tabs", () => {
  it("reopens a closed tab, including from saved history", async () => {
    const store = useRightPanelStore.getState();
    store.openPlugin(ref, { kind: "plugin", ...clock });
    store.closeSurface(ref, "plugin:example.echo-clock:clock");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces,
    ).toEqual([]);

    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: { entries: useClosedViewStore.getState().entries },
      version: 2,
    });
    await useClosedViewStore.persist.rehydrate();
    const [entry] = useClosedViewStore.getState().entries;
    expect(entry?.kind === "panel-tab" && entry.surface.kind).toBe("plugin");

    await reopenClosedView(entry!, {
      workspaceAvailable: true,
      openPreview: () => {
        throw new Error("A plugin tab must not create a browser session");
      },
    });
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
      kind: "plugin",
      id: "plugin:example.echo-clock:clock",
      ...clock,
    });
  });

  it("drops saved history entries that lack a view", async () => {
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: {
        entries: [
          {
            id: "bad",
            kind: "panel-tab",
            threadRef: ref,
            surface: { kind: "plugin", id: "plugin:x:y" },
          },
        ],
      },
      version: 1,
    });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.getState().entries).toEqual([]);
  });

  it("removes only tabs of the environment whose view is gone, leaving other tabs alone", () => {
    const store = useRightPanelStore.getState();
    store.openPlugin(ref, { kind: "plugin", ...clock });
    store.openPlugin(ref, { kind: "plugin", ...notes });
    store.openFile(ref, "src/app.ts");
    store.openPlugin(otherEnvironmentRef, { kind: "plugin", ...clock });

    const pruned = prunePluginSurfaces(
      useRightPanelStore.getState().byThreadKey,
      environmentId,
      new Set(["plugin:example.notes:notes"]),
    );
    const here = selectThreadRightPanelState(pruned, ref);
    expect(here.surfaces.map((surface) => surface.id)).toEqual([
      "plugin:example.notes:notes",
      "file:src/app.ts",
    ]);
    expect(selectThreadRightPanelState(pruned, otherEnvironmentRef).surfaces).toHaveLength(1);
    // Nothing to remove keeps the very same state, so subscribers are not woken.
    expect(
      prunePluginSurfaces(pruned, environmentId, new Set(["plugin:example.notes:notes"])),
    ).toBe(pruned);
  });

  it("closes the panel when pruning removes its last tab", () => {
    useRightPanelStore.getState().openPlugin(ref, { kind: "plugin", ...clock });
    const pruned = prunePluginSurfaces(
      useRightPanelStore.getState().byThreadKey,
      environmentId,
      new Set(),
    );
    expect(selectThreadRightPanelState(pruned, ref)).toMatchObject({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });
});
