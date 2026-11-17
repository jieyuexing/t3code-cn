import type { PluginHostCallInput } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { usePluginHostCall } from "./usePluginHost";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

const isUsage = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((bytes) => typeof bytes === "number");

/**
 * Bytes each plugin's cache holds, read from the host when the page opens and again on `refresh`
 * (after clearing), not on every snapshot: the host answers from its in-memory index.
 */
export function usePluginCacheUsage(
  call: ReturnType<typeof usePluginHostCall>,
  pluginIds: string,
): { readonly usage: Readonly<Record<string, number>>; readonly refresh: () => Promise<void> } {
  const [usage, setUsage] = useState<Readonly<Record<string, number>>>({});
  const refresh = useStableCallback(async () => {
    const result = await call({ _tag: "cacheUsage" } satisfies PluginHostCallInput);
    if (result._tag === "Success" && isUsage(result.value.value)) setUsage(result.value.value);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's cache sizes when the page opens or the plugin list changes
  useEffect(() => {
    if (pluginIds !== "") void refresh();
  }, [pluginIds, refresh]);
  return { usage, refresh };
}
