import { DEFAULT_RAIL_CONFIG, type PluginHostSnapshot, type RailConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../../rightPanelStore";
import { providerEntry } from "../testing/snapshots";
import {
  groupRailItems,
  isRailItemShowing,
  moveItem,
  parseWebAppUrl,
  railOf,
  railPluginState,
  resolveRailClick,
  togglePin,
  upsertWebApp,
  type PluginAppItem,
  type RailWebContext,
  type WebAppItem,
} from "./rail.logic";

const docs: WebAppItem = { _tag: "web", id: "w1", title: "Docs", url: "https://docs.test/" };
const wiki: WebAppItem = { _tag: "web", id: "w2", title: "Wiki", url: "https://wiki.test/" };
const context: RailWebContext = {
  webApps: [docs, wiki],
  openedTabs: { w1: "t-docs" },
  pageUrls: {
    "t-docs": "https://docs.test/",
    "t-wiki": "https://wiki.test",
    "t-plain": "https://x.test/",
  },
};
const browser = { _tag: "builtin", id: "browser" } as const;
const terminal = { _tag: "builtin", id: "terminal" } as const;
const diff = { _tag: "builtin", id: "diff" } as const;
const preview = (tabId: string): RightPanelSurface => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});
const terminalSurface = { id: "terminal:1", kind: "terminal" } as unknown as RightPanelSurface;
const diffSurface: RightPanelSurface = { id: "diff", kind: "diff" };
const panel = (
  isOpen: boolean,
  activeSurfaceId: string | null,
  ...surfaces: RightPanelSurface[]
) => ({
  isOpen,
  activeSurfaceId,
  surfaces,
});

describe("resolveRailClick", () => {
  it("opens a new tab when the thread has none of that kind", () => {
    expect(resolveRailClick(panel(true, "diff", diffSurface), terminal, context)).toEqual({
      _tag: "open",
    });
  });

  it("switches to the existing tab, opening the panel if it was folded", () => {
    expect(
      resolveRailClick(panel(false, "diff", diffSurface, terminalSurface), terminal, context),
    ).toEqual({
      _tag: "activate",
      surface: terminalSurface,
    });
    expect(
      resolveRailClick(panel(true, "diff", diffSurface, terminalSurface), terminal, context),
    ).toEqual({
      _tag: "activate",
      surface: terminalSurface,
    });
  });

  it("folds the panel when the clicked item is the one showing", () => {
    expect(resolveRailClick(panel(true, "diff", diffSurface), diff, context)).toEqual({
      _tag: "collapse",
    });
  });

  it("reopens a folded panel on the item that was showing when it folded", () => {
    expect(resolveRailClick(panel(false, "diff", diffSurface), diff, context)._tag).toBe(
      "activate",
    );
  });

  it("keeps web app tabs apart from the browser's own tabs", () => {
    const tabs = panel(true, "browser:t-docs", preview("t-docs"), preview("t-plain"));
    expect(resolveRailClick(tabs, docs, context)).toEqual({ _tag: "collapse" });
    expect(resolveRailClick(tabs, browser, context)).toEqual({
      _tag: "activate",
      surface: preview("t-plain"),
    });
    expect(isRailItemShowing(tabs, browser, context)).toBe(false);
    expect(isRailItemShowing(tabs, docs, context)).toBe(true);
  });

  it("finds a web app's tab by its page when it was opened before this session", () => {
    const tabs = panel(true, "browser:t-plain", preview("t-wiki"), preview("t-plain"));
    expect(resolveRailClick(tabs, wiki, context)).toEqual({
      _tag: "activate",
      surface: preview("t-wiki"),
    });
  });

  it("matches a plugin app by plugin and view", () => {
    const view: RightPanelSurface = {
      id: "plugin:p:v",
      kind: "plugin",
      pluginId: "p",
      viewId: "v",
      title: "P",
    };
    const item: PluginAppItem = { _tag: "plugin", pluginId: "p" as never, viewId: "v", title: "P" };
    expect(resolveRailClick(panel(true, "plugin:p:v", view), item, context)._tag).toBe("collapse");
    expect(
      resolveRailClick(panel(true, "plugin:p:v", view), { ...item, viewId: "w" }, context)._tag,
    ).toBe("open");
  });
});

describe("rail config edits", () => {
  const config: RailConfig = {
    enabled: true,
    items: [
      browser,
      { _tag: "plugin", pluginId: "p" as never, viewId: "v", title: "P" },
      docs,
      terminal,
      wiki,
    ],
  };

  it("starts with the four common panels pinned and the rail on", () => {
    expect(DEFAULT_RAIL_CONFIG.enabled).toBe(true);
    expect(DEFAULT_RAIL_CONFIG.items.map((item) => item._tag === "builtin" && item.id)).toEqual([
      "browser",
      "terminal",
      "files",
      "diff",
    ]);
    expect(railOf(null)).toBe(DEFAULT_RAIL_CONFIG);
  });

  it("pins and unpins by identity", () => {
    const unpinned = togglePin(config, terminal);
    expect(unpinned.items).not.toContainEqual(terminal);
    expect(togglePin(unpinned, terminal).items.at(-1)).toEqual(terminal);
  });

  it("adds a web app once and edits it in place", () => {
    const renamed = upsertWebApp(config, { ...docs, title: "Handbook" });
    expect(renamed.items).toHaveLength(config.items.length);
    expect(renamed.items[2]).toEqual({ ...docs, title: "Handbook" });
    const added = upsertWebApp(config, { ...docs, id: "w3" });
    expect(added.items.at(-1)).toMatchObject({ id: "w3" });
  });

  it("reorders within a group and ignores moves across groups", () => {
    const moved = moveItem(config, "web:w2", "web:w1");
    expect(groupRailItems(moved).web.map((item) => item.id)).toEqual(["w2", "w1"]);
    expect(groupRailItems(moved).builtin).toEqual(groupRailItems(config).builtin);
    expect(moveItem(config, "web:w1", "builtin:terminal")).toBe(config);
    expect(moveItem(config, "web:w1", "web:nope")).toBe(config);
  });
});

describe("parseWebAppUrl", () => {
  it("takes only http and https pages", () => {
    expect(parseWebAppUrl(" https://a.test/x ")).toBe("https://a.test/x");
    expect(parseWebAppUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    for (const bad of ["javascript:alert(1)", "file:///etc/hosts", "a.test", ""]) {
      expect(parseWebAppUrl(bad)).toBeNull();
    }
  });
});

const snapshotWith = (
  state: "standby" | "running" | "waiting" | "quarantined",
  view: { readonly viewId: string } = { viewId: "clock" },
): PluginHostSnapshot => ({
  hostEnabled: true,
  registered: 1,
  plugins: [
    providerEntry("example.echo-clock", "Echo Clock", "clock", [], {
      state:
        state === "quarantined"
          ? { _tag: "quarantined", failures: 3, reason: "x" }
          : state === "waiting"
            ? { _tag: "waiting", reason: "x" }
            : { _tag: state },
    }),
  ],
  views: [
    {
      pluginId: "example.echo-clock" as never,
      pluginName: "Echo Clock",
      generation: 1,
      viewId: view.viewId,
      title: "Clock",
      placement: "side-panel",
    },
  ],
  services: [],
});

describe("railPluginState", () => {
  const item: PluginAppItem = {
    _tag: "plugin",
    pluginId: "example.echo-clock" as never,
    viewId: "clock",
    title: "Clock",
  };

  it("is ready while the plugin offers the view, running or not yet started", () => {
    expect(railPluginState(item, snapshotWith("standby")).ready).toBe(true);
    expect(railPluginState(item, snapshotWith("running")).ready).toBe(true);
  });

  it("greys out a plugin that is waiting, stopped, missing or no longer offers the view", () => {
    expect(railPluginState(item, snapshotWith("waiting"))).toEqual({
      ready: false,
      reason: "Waiting for services",
      tone: "warning",
    });
    expect(railPluginState(item, snapshotWith("quarantined"))).toMatchObject({
      ready: false,
      tone: "error",
    });
    expect(railPluginState(item, snapshotWith("standby", { viewId: "other" })).ready).toBe(false);
    expect(
      railPluginState({ ...item, pluginId: "gone" as never }, snapshotWith("standby")).ready,
    ).toBe(false);
    expect(railPluginState(item, null).ready).toBe(false);
  });
});
