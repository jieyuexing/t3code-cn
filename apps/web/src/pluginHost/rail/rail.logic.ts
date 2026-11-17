import {
  DEFAULT_RAIL_CONFIG,
  railItemKey,
  type PluginHostSnapshot,
  type RailBuiltinId,
  type RailConfig,
  type RailItem,
} from "@t3tools/contracts";

import type { RightPanelSurface, ThreadRightPanelState } from "../../rightPanelStore";
import { openableUrl } from "../openUrl";
import { PLUGIN_STATUS_VARIANT_BY_KIND, pluginStatus } from "../pluginStatus";

export type WebAppItem = Extract<RailItem, { _tag: "web" }>;
export type PluginAppItem = Extract<RailItem, { _tag: "plugin" }>;

/** The rail as the environment reports it; a server that predates the rail reports none. */
export const railOf = (snapshot: PluginHostSnapshot | null): RailConfig =>
  snapshot?.rail ?? DEFAULT_RAIL_CONFIG;

/** `needsYou` opens a popup, not a tab. */
const SURFACE_KIND_OF_BUILTIN: Readonly<Record<RailBuiltinId, RightPanelSurface["kind"] | null>> = {
  browser: "preview",
  terminal: "terminal",
  files: "files",
  diff: "diff",
  pullRequest: "pull-request",
  pullRequests: "pull-requests",
  device: "device",
  sideChat: "side-chat",
  needsYou: null,
};

/** What tells a browser tab opened for a web app from any other tab of the thread's browser. */
export interface RailWebContext {
  readonly webApps: ReadonlyArray<WebAppItem>;
  /** The tab each web app was opened in during this session, by web app id. */
  readonly openedTabs: Readonly<Record<string, string>>;
  /** The page each tab shows now, by tab id. */
  readonly pageUrls: Readonly<Record<string, string>>;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function webAppOfTab(tabId: string | null, context: RailWebContext): string | undefined {
  if (tabId === null) return undefined;
  for (const [appId, openedTab] of Object.entries(context.openedTabs)) {
    if (openedTab === tabId) return appId;
  }
  const pageUrl = context.pageUrls[tabId];
  return pageUrl === undefined
    ? undefined
    : context.webApps.find((app) => sameUrl(app.url, pageUrl))?.id;
}

function surfaceMatchesItem(
  surface: RightPanelSurface,
  item: RailItem,
  context: RailWebContext,
): boolean {
  switch (item._tag) {
    case "builtin":
      if (surface.kind !== SURFACE_KIND_OF_BUILTIN[item.id]) return false;
      return (
        item.id !== "browser" ||
        (surface.kind === "preview" && webAppOfTab(surface.resourceId, context) === undefined)
      );
    case "plugin":
      return (
        surface.kind === "plugin" &&
        surface.pluginId === item.pluginId &&
        surface.viewId === item.viewId
      );
    case "web":
      return surface.kind === "preview" && webAppOfTab(surface.resourceId, context) === item.id;
  }
}

export type RailClick =
  | { readonly _tag: "collapse" }
  | { readonly _tag: "activate"; readonly surface: RightPanelSurface }
  | { readonly _tag: "open" };

type PanelView = Pick<ThreadRightPanelState, "isOpen" | "activeSurfaceId" | "surfaces">;

/** A click on the item showing in the open panel folds the panel; otherwise it goes to a tab of that kind, or opens one. */
export function resolveRailClick(
  panel: PanelView,
  item: RailItem,
  context: RailWebContext,
): RailClick {
  const matches = panel.surfaces.filter((surface) => surfaceMatchesItem(surface, item, context));
  const showing = matches.find((surface) => surface.id === panel.activeSurfaceId);
  if (showing !== undefined && panel.isOpen) return { _tag: "collapse" };
  const target = showing ?? matches[0];
  return target === undefined ? { _tag: "open" } : { _tag: "activate", surface: target };
}

export const isRailItemShowing = (panel: PanelView, item: RailItem, context: RailWebContext) =>
  panel.isOpen &&
  panel.surfaces.some(
    (surface) => surface.id === panel.activeSurfaceId && surfaceMatchesItem(surface, item, context),
  );

export const isPinned = (config: RailConfig, item: RailItem) =>
  config.items.some(
    (entry) =>
      railItemKey(entry) === railItemKey(item) && (entry._tag !== "web" || entry.pinned !== false),
  );

/** Pins or unpins; a web app stays in the list unpinned, anything else leaves it. */
export function togglePin(config: RailConfig, item: RailItem): RailConfig {
  const key = railItemKey(item);
  if (item._tag === "web") {
    const pinned = !isPinned(config, item);
    return {
      ...config,
      items: config.items.map((entry) =>
        entry._tag === "web" && railItemKey(entry) === key ? { ...entry, pinned } : entry,
      ),
    };
  }
  return {
    ...config,
    items: isPinned(config, item)
      ? config.items.filter((entry) => railItemKey(entry) !== key)
      : [...config.items, item],
  };
}

export const removeItem = (config: RailConfig, item: RailItem): RailConfig => ({
  ...config,
  items: config.items.filter((entry) => railItemKey(entry) !== railItemKey(item)),
});

export function upsertWebApp(config: RailConfig, app: WebAppItem): RailConfig {
  const exists = config.items.some((entry) => entry._tag === "web" && entry.id === app.id);
  return {
    ...config,
    items: exists
      ? config.items.map((entry) => (entry._tag === "web" && entry.id === app.id ? app : entry))
      : [...config.items, app],
  };
}

/** Moves `fromKey` to where `toKey` is; items only trade places within their own group. */
export function moveItem(config: RailConfig, fromKey: string, toKey: string): RailConfig {
  const from = config.items.findIndex((entry) => railItemKey(entry) === fromKey);
  const to = config.items.findIndex((entry) => railItemKey(entry) === toKey);
  const moved = config.items[from];
  if (moved === undefined || to < 0 || from === to || config.items[to]?._tag !== moved._tag) {
    return config;
  }
  const items = config.items.filter((_, index) => index !== from);
  items.splice(to, 0, moved);
  return { ...config, items };
}

/** The rail lists built-in panels, then plugin apps, then web apps, each group in pinned order. */
export function groupRailItems(config: RailConfig) {
  return {
    builtin: config.items.filter((item) => item._tag === "builtin"),
    plugin: config.items.filter((item): item is PluginAppItem => item._tag === "plugin"),
    web: config.items.filter(
      (item): item is WebAppItem => item._tag === "web" && item.pinned !== false,
    ),
  };
}

const ITEM_HEIGHT = 32;
const ITEM_GAP = 4;
const GROUP_SEPARATOR = 9;
/** What the overflow button takes from the rail when it shows. */
export const RAIL_OVERFLOW_ROW = ITEM_GAP + ITEM_HEIGHT;

/** The height of the details button and the groups of `items`, which come builtin, plugin, web. */
function railItemsHeight(items: ReadonlyArray<RailItem>): number {
  let height = ITEM_HEIGHT;
  for (const tag of ["builtin", "plugin", "web"] as const) {
    const count = items.filter((item) => item._tag === tag).length;
    if (count > 0) height += GROUP_SEPARATOR + count * ITEM_HEIGHT + (count - 1) * ITEM_GAP;
  }
  return height;
}

/**
 * Splits `items` into what the rail shows in `available` px and what moves into the overflow menu, from the end;
 * `needsYou` has a popup of its own and always shows. An unknown height shows everything.
 */
export function fitRailItems(
  items: ReadonlyArray<RailItem>,
  available: number | null,
): { readonly visible: ReadonlyArray<RailItem>; readonly hidden: ReadonlyArray<RailItem> } {
  if (available === null || railItemsHeight(items) <= available) {
    return { visible: items, hidden: [] };
  }
  const budget = available - RAIL_OVERFLOW_ROW;
  const isSticky = (item: RailItem) => item._tag === "builtin" && item.id === "needsYou";
  const visible = items.filter(isSticky);
  const hidden: Array<RailItem> = [];
  for (const item of items) {
    if (isSticky(item)) continue;
    const next = [...visible, item];
    if (hidden.length === 0 && railItemsHeight(next) <= budget) visible.push(item);
    else hidden.push(item);
  }
  return { visible: items.filter((item) => visible.includes(item)), hidden };
}

export type RailPluginState =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: string;
      /** Set when the plugin needs attention, as opposed to being switched off or gone. */
      readonly tone?: "warning" | "error";
    };

/** A plugin app is usable while its plugin is enabled, consented, not stopped and still offers the view. */
export function railPluginState(
  item: PluginAppItem,
  snapshot: PluginHostSnapshot | null,
): RailPluginState {
  const plugin = snapshot?.plugins.find((entry) => entry.id === item.pluginId);
  if (plugin === undefined) return { ready: false, reason: "The plugin is not installed" };
  if (!plugin.enabled) return { ready: false, reason: "The plugin is not enabled" };
  const status = pluginStatus(plugin);
  if (status.kind !== "standby" && status.kind !== "running") {
    const tone = PLUGIN_STATUS_VARIANT_BY_KIND[status.kind];
    return tone === "warning" || tone === "error"
      ? { ready: false, reason: status.label, tone }
      : { ready: false, reason: status.label };
  }
  const offered = snapshot?.views.some(
    (view) => view.pluginId === item.pluginId && view.viewId === item.viewId,
  );
  return offered
    ? { ready: true }
    : { ready: false, reason: "The plugin no longer offers this app" };
}

/** The address a web app may open, or `null` for anything but an http(s) page. */
export function parseWebAppUrl(value: string): string | null {
  try {
    return openableUrl(value.trim());
  } catch {
    return null;
  }
}

/** The first letter of a title, for the glyph of an app without an icon. */
export const monogram = (title: string) => [...title.trim()][0]?.toUpperCase() ?? "?";
