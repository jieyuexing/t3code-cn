import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, PluginId, ThreadId, type PluginHostSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { startPluginSurfacePruning } from "./pruneSurfaces";

const fixture = vi.hoisted(() => ({
  atoms: new Map<string, unknown>(),
}));

vi.mock("./state", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    pluginHostEnvironment: {
      snapshot: ({ environmentId }: { environmentId: string }) => {
        const existing = fixture.atoms.get(environmentId);
        if (existing !== undefined) return existing;
        const created = Atom.make(AsyncResult.initial<PluginHostSnapshot>());
        fixture.atoms.set(environmentId, created);
        return created;
      },
    },
  };
});

const first = EnvironmentId.make("env-1");
const second = EnvironmentId.make("env-2");
const refFirst = scopeThreadRef(first, ThreadId.make("thread-A"));
const refSecond = scopeThreadRef(second, ThreadId.make("thread-A"));
const clock = {
  kind: "plugin",
  pluginId: "example.echo-clock",
  viewId: "clock",
  title: "Clock",
} as const;
const notes = {
  kind: "plugin",
  pluginId: "example.notes",
  viewId: "notes",
  title: "Notes",
} as const;

const frame = (viewIds: readonly string[]): PluginHostSnapshot => ({
  hostEnabled: true,
  registered: viewIds.length,
  plugins: [],
  commands: [],
  services: [],
  views: viewIds.map((viewId) => ({
    pluginId: PluginId.make(viewId === "clock" ? "example.echo-clock" : "example.notes"),
    pluginName: viewId,
    generation: 1,
    viewId,
    title: viewId,
    placement: "side-panel",
  })),
});

const publish = (environmentId: EnvironmentId, snapshot: PluginHostSnapshot) =>
  appAtomRegistry.set(
    fixture.atoms.get(environmentId) as Atom.Writable<AsyncResult.AsyncResult<PluginHostSnapshot>>,
    AsyncResult.success(snapshot),
  );

const ids = (ref: typeof refFirst) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.map(
    (surface) => surface.id,
  );

describe("startPluginSurfacePruning", () => {
  beforeEach(() => {
    fixture.atoms.clear();
    useRightPanelStore.setState({ byThreadKey: {} });
  });

  it("prunes once, on the first snapshot of an environment that has plugin tabs", () => {
    const store = useRightPanelStore.getState();
    store.openPlugin(refFirst, clock);
    store.openPlugin(refFirst, notes);
    store.openFile(refSecond, "src/app.ts");

    startPluginSurfacePruning();
    // Only the environment with plugin tabs is watched.
    expect([...fixture.atoms.keys()]).toEqual([first]);
    expect(ids(refFirst)).toHaveLength(2);

    publish(first, frame(["notes"]));
    expect(ids(refFirst)).toEqual(["plugin:example.notes:notes"]);

    // Later snapshots no longer prune: a tab whose view vanished stays and shows as unavailable.
    useRightPanelStore.getState().openPlugin(refFirst, clock);
    publish(first, frame([]));
    expect(ids(refFirst)).toEqual([
      "plugin:example.notes:notes",
      "plugin:example.echo-clock:clock",
    ]);
    expect(ids(refSecond)).toEqual(["file:src/app.ts"]);
  });
});
