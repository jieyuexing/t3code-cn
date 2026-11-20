import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../components/CommandPalette.logic";
import { toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { launcherViews, openPluginView } from "./launcherViews";
import { methodKey, useServicePanelStore } from "./servicePanelStore";
import { availableUiMethods, emptyInput, methodNeedsInput, serviceViewId } from "./serviceMethods";
import { pluginHostEnvironment } from "./state";
import {
  pluginHostFailureMessage,
  useCanCallPluginHost,
  usePluginHostSnapshot,
} from "./usePluginHost";

/**
 * Palette entries for the environment of the open thread (or the primary one): the built-in
 * command that opens plugin settings, and a "Plugins" group with each plugin's views, the service
 * methods marked `ui` and a service panel entry per service. A method that needs input opens its form.
 */
function openServicePanel(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  providerId: string,
  service: string,
  method?: string,
) {
  useRightPanelStore.getState().openPlugin(scopeThreadRef(thread.environmentId, thread.id), {
    kind: "plugin",
    pluginId: providerId,
    viewId: serviceViewId(service),
    title: service,
  });
  if (method !== undefined)
    useServicePanelStore.getState().requestFocus(methodKey(thread.environmentId, service, method));
}

export function usePluginPaletteItems(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
  fallbackEnvironmentId: EnvironmentId | null,
) {
  const environmentId = thread?.environmentId ?? fallbackEnvironmentId;
  const navigate = useNavigate();
  const call = useAtomCommand(pluginHostEnvironment.call, { reportFailure: false });
  const { snapshot } = usePluginHostSnapshot(environmentId);
  const canCall = useCanCallPluginHost(environmentId);

  const settingsItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:plugin-settings",
    searchTerms: ["plugins", "extensions", "settings"],
    title: "Open plugin settings",
    icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: "/settings/plugins",
        ...(environmentId === null ? {} : { search: { machine: environmentId } }),
      });
    },
  };

  const items: CommandPaletteActionItem[] = [];
  if (environmentId !== null && snapshot !== null && canCall) {
    const providers = new Map<string, { readonly id: string; readonly name: string }>();
    for (const entry of availableUiMethods(snapshot)) {
      providers.set(entry.service, { id: entry.provider.id, name: entry.provider.name });
      const needsInput = methodNeedsInput(entry.method);
      if (needsInput && !thread) continue;
      const title = needsInput ? `${entry.title}…` : entry.title;
      items.push({
        kind: "action",
        value: `plugin-method:${entry.service}:${entry.method.name}`,
        searchTerms: [
          entry.title,
          entry.service,
          entry.method.name,
          entry.provider.name,
          "plugin",
          ...(entry.method.description ? [entry.method.description] : []),
        ],
        searchTitle: title,
        title,
        timestamp: entry.service,
        ...(entry.method.description === undefined
          ? {}
          : { description: entry.method.description }),
        icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
        ...(entry.method.readOnly === true
          ? {}
          : {
              titleTrailingContent: <Badge variant="outline">Modifies</Badge>,
            }),
        run: async () => {
          if (needsInput && thread) {
            openServicePanel(thread, entry.provider.id, entry.service, entry.method.name);
            return;
          }
          const result = await call({
            environmentId,
            input: {
              _tag: "callService",
              service: entry.service,
              method: entry.method.name,
              input: emptyInput(entry.method),
            },
          });
          if (result._tag === "Success") {
            // Every run gets feedback; a method that returns nothing still ran.
            const value = result.value.value;
            const description =
              value === null || value === undefined
                ? undefined
                : typeof value === "string"
                  ? value
                  : JSON.stringify(value).slice(0, 300);
            toastManager.add({
              type: "info",
              title: entry.title,
              ...(description === undefined ? {} : { description }),
            });
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: entry.title,
              description: pluginHostFailureMessage(result),
            });
          }
        },
      });
    }
    if (thread) {
      for (const [service, provider] of providers) {
        items.push({
          kind: "action",
          value: `plugin-service:${service}`,
          searchTerms: [service, provider.name, "plugin", "service", "panel"],
          title: `Open ${service}`,
          timestamp: provider.name,
          icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
          run: async () => openServicePanel(thread, provider.id, service),
        });
      }
      for (const view of launcherViews(snapshot, canCall)) {
        items.push({
          kind: "action",
          value: `plugin-view:${view.pluginId}:${view.viewId}`,
          searchTerms: [view.title, view.pluginName, "plugin", "panel", "view"],
          title: `Open ${view.title}`,
          timestamp: view.pluginName,
          icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
          run: async () => openPluginView(scopeThreadRef(thread.environmentId, thread.id), view),
        });
      }
    }
  }
  const groups: CommandPaletteGroup[] =
    items.length === 0 ? [] : [{ value: "plugins", label: "Plugins", items }];
  return { settingsItem, groups };
}
