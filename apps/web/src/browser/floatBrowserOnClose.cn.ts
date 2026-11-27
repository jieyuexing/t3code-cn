import { useSyncExternalStore } from "react";

const STORAGE_KEY = "t3code-cn:float-browser-on-close:v1";

const listeners = new Set<() => void>();

/**
 * Off by default: closing the browser panel just closes it. On restores upstream's mini player,
 * which useRightPanelActions then floats under upstream's own rules. Devices are not affected.
 */
export function getFloatBrowserOnClose(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setFloatBrowserOnClose(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, "true");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFloatBrowserOnClose(): boolean {
  return useSyncExternalStore(subscribe, getFloatBrowserOnClose, () => false);
}
