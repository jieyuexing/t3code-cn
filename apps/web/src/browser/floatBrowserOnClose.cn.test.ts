import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import {
  floatBrowserOnClose,
  getFloatBrowserOnClose,
  setFloatBrowserOnClose,
} from "./floatBrowserOnClose.cn";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const miniPlayer = () =>
  selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, ref);

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("floatBrowserOnClose", () => {
  it("does not open the mini player by default", () => {
    expect(getFloatBrowserOnClose()).toBe(false);
    floatBrowserOnClose(ref, "tab-a");
    expect(miniPlayer()).toBeNull();
  });

  it("keeps upstream's mini player once the setting is on, and stops when it is turned off", () => {
    setFloatBrowserOnClose(true);
    floatBrowserOnClose(ref, "tab-a");
    expect(miniPlayer()?.source).toEqual({ kind: "browser", tabId: "tab-a" });

    usePreviewMiniPlayerStore.getState().close(ref);
    setFloatBrowserOnClose(false);
    floatBrowserOnClose(ref, "tab-a");
    expect(miniPlayer()).toBeNull();
  });

  it("treats unreadable storage as off", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(getFloatBrowserOnClose()).toBe(false);
  });
});
