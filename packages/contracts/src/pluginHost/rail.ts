// The right app rail's pinned items: one list per environment, kept by the server so another client sees it too.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { PluginId } from "./manifest.ts";

/** What a rail can pin of T3's own: the right panel's surfaces, each opening the matching tab, and `needsYou`, the list of threads waiting on the user. */
export const RAIL_BUILTIN_IDS = [
  "browser",
  "terminal",
  "files",
  "diff",
  "pullRequest",
  "pullRequests",
  "device",
  "sideChat",
  "needsYou",
] as const;
export const RailBuiltinId = Schema.Literals(RAIL_BUILTIN_IDS);
export type RailBuiltinId = typeof RailBuiltinId.Type;

export const RAIL_MAX_ITEMS = 64;

/** Only web pages: the rail opens them in the thread's T3 browser. */
export const RailWebUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/\S+$/i),
);

export const RailItem = Schema.Union([
  Schema.TaggedStruct("builtin", { id: RailBuiltinId }),
  /** The title is kept so a plugin that is not running still shows, greyed out. */
  Schema.TaggedStruct("plugin", {
    pluginId: PluginId,
    viewId: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  }),
  Schema.TaggedStruct("web", {
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
    url: RailWebUrl,
    /** A browser profile id; without one the browser's default profile is used. */
    profileId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
    /** `false` keeps the app in the list without showing it on the rail; a built-in or plugin app is unpinned by leaving the list. */
    pinned: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type RailItem = typeof RailItem.Type;

export const railItemKey = (item: RailItem): string =>
  item._tag === "builtin"
    ? `builtin:${item.id}`
    : item._tag === "plugin"
      ? `plugin:${item.pluginId}:${item.viewId}`
      : `web:${item.id}`;

export const RailConfig = Schema.Struct({
  /** The settings switch; off removes the rail and leaves the pinned items as they are. */
  enabled: Schema.Boolean,
  items: Schema.Array(RailItem).check(
    Schema.isMaxLength(RAIL_MAX_ITEMS),
    Schema.makeFilter(
      (items) =>
        new Set(items.map(railItemKey)).size === items.length || "A rail item is pinned once.",
    ),
  ),
});
export type RailConfig = typeof RailConfig.Type;

/** What a server without a `rail.json` reports. */
export const DEFAULT_RAIL_CONFIG: RailConfig = {
  enabled: true,
  items: [
    { _tag: "builtin", id: "browser" },
    { _tag: "builtin", id: "terminal" },
    { _tag: "builtin", id: "files" },
    { _tag: "builtin", id: "diff" },
    { _tag: "builtin", id: "needsYou" },
  ],
};
