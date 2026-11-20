import type { PluginHostEntry } from "@t3tools/contracts";

export type PluginStatusKind =
  | "standby"
  | "running"
  | "waiting"
  | "quarantined"
  | "approval"
  | "off";

const PLUGIN_STATUS_LABEL_BY_KIND: Readonly<Record<PluginStatusKind, string>> = {
  standby: "Standby",
  running: "Running",
  waiting: "Waiting for services",
  quarantined: "Quarantined",
  approval: "Awaiting consent",
  off: "Not enabled",
};

export const PLUGIN_STATUS_VARIANT_BY_KIND = {
  standby: "outline",
  running: "success",
  waiting: "warning",
  quarantined: "error",
  approval: "warning",
  off: "outline",
} as const satisfies Readonly<Record<PluginStatusKind, string>>;

/** The words a user sees; backoff reads as quarantined and an idle plugin as off. */
export function pluginStatus(plugin: PluginHostEntry): { kind: PluginStatusKind; label: string } {
  const kind = pluginStatusKind(plugin);
  return { kind, label: PLUGIN_STATUS_LABEL_BY_KIND[kind] };
}

function pluginStatusKind(plugin: PluginHostEntry): PluginStatusKind {
  // A plugin that cannot load has nothing to approve.
  if (plugin.state._tag === "idle" && plugin.problem !== undefined) return "off";
  if (plugin.consent === "required") return "approval";
  switch (plugin.state._tag) {
    case "idle":
      return "off";
    case "standby":
      return "standby";
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "backoff":
    case "quarantined":
      return "quarantined";
  }
}
