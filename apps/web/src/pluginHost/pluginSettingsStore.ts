import type { EnvironmentId, PluginId } from "@t3tools/contracts";
import { create } from "zustand";

export const pluginSettingsKey = (environmentId: EnvironmentId, pluginId: PluginId) =>
  `${environmentId}|${pluginId}`;

interface PluginSettingsState {
  /** The plugin rows whose settings form is expanded. */
  readonly opened: Readonly<Record<string, true>>;
  /** The row a view asked for with `t3.openPluginSettings`; its row scrolls into view and clears this. */
  readonly reveal: string | null;
}

/**
 * Which plugin rows show their settings form. It lives outside the row because a view opens a form
 * from another page: the settings page may not be mounted yet when the request is made.
 */
export const usePluginSettingsStore = create<PluginSettingsState>()(() => ({
  opened: {},
  reveal: null,
}));

export const setPluginSettingsOpen = (key: string, open: boolean) =>
  usePluginSettingsStore.setState(({ opened }) => {
    const { [key]: _closed, ...rest } = opened;
    return { opened: open ? { ...rest, [key]: true } : rest };
  });

export const requestPluginSettings = (key: string) =>
  usePluginSettingsStore.setState(({ opened }) => ({
    opened: { ...opened, [key]: true },
    reveal: key,
  }));

export const clearPluginSettingsReveal = () => usePluginSettingsStore.setState({ reveal: null });
