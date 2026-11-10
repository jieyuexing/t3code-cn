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
import { pluginHostEnvironment } from "./state";
import {
  pluginHostFailureMessage,
  useCanCallPluginHost,
  usePluginHostSnapshot,
} from "./usePluginHost";

/**
 * Palette entries for the environment of the open thread (or the primary one): the built-in
 * command that opens plugin settings, and a "Plugins" group with each plugin's views and commands.
 */
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
    if (thread) {
      for (const view of snapshot.views) {
        items.push({
          kind: "action",
          value: `plugin-view:${view.pluginId}:${view.viewId}`,
          searchTerms: [view.title, view.pluginName, "plugin", "panel", "view"],
          title: `Open ${view.title}`,
          timestamp: view.pluginName,
          icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            useRightPanelStore
              .getState()
              .openPlugin(scopeThreadRef(thread.environmentId, thread.id), {
                kind: "plugin",
                pluginId: view.pluginId,
                viewId: view.viewId,
                title: view.title,
              });
          },
        });
      }
    }
    for (const command of snapshot.commands) {
      items.push({
        kind: "action",
        value: `plugin-command:${command.pluginId}:${command.commandId}`,
        searchTerms: [
          command.title,
          command.pluginName,
          "plugin",
          ...(command.description ? [command.description] : []),
        ],
        title: command.title,
        timestamp: command.pluginName,
        ...(command.description === undefined ? {} : { description: command.description }),
        icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          const result = await call({
            environmentId,
            input: {
              _tag: "invoke",
              pluginId: command.pluginId,
              handler: `command:${command.commandId}`,
              input: null,
            },
          });
          if (result._tag === "Success") {
            const value = result.value.value;
            if (typeof value === "string") {
              toastManager.add({ type: "info", title: command.title, description: value });
            }
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: command.title,
              description: pluginHostFailureMessage(result),
            });
          }
        },
      });
    }
  }
  const groups: CommandPaletteGroup[] =
    items.length === 0 ? [] : [{ value: "plugins", label: "Plugins", items }];
  return { settingsItem, groups };
}
