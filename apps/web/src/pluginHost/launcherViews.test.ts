import { PluginId, type PluginHostSnapshot, type PluginHostView } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { launcherViews } from "./launcherViews";

const view = (plugin: string, viewId: string): PluginHostView => ({
  pluginId: PluginId.make(plugin),
  pluginName: plugin,
  generation: 1,
  viewId,
  title: viewId,
  placement: "right-panel",
});

const snapshot = (hostEnabled: boolean, views: PluginHostView[]): PluginHostSnapshot => ({
  hostEnabled,
  registered: 2,
  plugins: [],
  views,
  services: [],
});

it("lists every plugin's views in the host's order", () => {
  const views = [view("a.one", "inbox"), view("b.two", "git"), view("a.one", "log")];
  expect(launcherViews(snapshot(true, views), true)).toEqual(views);
});

it("lists nothing without a snapshot, with the host off or without permission to call it", () => {
  const views = [view("a.one", "inbox")];
  expect(launcherViews(null, true)).toEqual([]);
  expect(launcherViews(snapshot(false, views), true)).toEqual([]);
  expect(launcherViews(snapshot(true, views), false)).toEqual([]);
  expect(launcherViews(snapshot(true, []), true)).toEqual([]);
});
