import { useSyncExternalStore } from "react";

import type { PluginViewContext } from "./bridge";

const THEME_VARIABLES = [
  ...[
    "--background",
    "--muted",
    "--card",
    "--popover",
    "--secondary",
    "--primary",
    "--accent",
    "--destructive",
    "--success",
    "--warning",
    "--info",
    "--code-background",
  ].flatMap((name) => [name, `${name}-foreground`]),
  "--foreground",
  "--border",
  "--input",
  "--ring",
  "--warning-surface",
  "--radius",
  "--font-sans",
  "--font-mono",
];

/** T3's theme as the app shows it now: the scheme, and the computed value of each variable it sets. */
function readPluginTheme(): PluginViewContext["theme"] {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARIABLES) {
    const value = styles.getPropertyValue(name).trim();
    if (value !== "") vars[name] = value;
  }
  return { scheme: root.classList.contains("dark") ? "dark" : "light", vars };
}

const subscribeToTheme = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => observer.disconnect();
};
const readEncodedTheme = () => JSON.stringify(readPluginTheme());

/** Where a view is shown: the thread's directory, and the theme, read again whenever the app restyles. */
export function usePluginViewContext(cwd: string | null): PluginViewContext {
  const theme = JSON.parse(
    useSyncExternalStore(subscribeToTheme, readEncodedTheme),
  ) as PluginViewContext["theme"];
  return { cwd, theme };
}
