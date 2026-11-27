import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getFloatBrowserOnClose, setFloatBrowserOnClose } from "./floatBrowserOnClose.cn";

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("floatBrowserOnClose setting", () => {
  it("is off by default", () => {
    expect(getFloatBrowserOnClose()).toBe(false);
  });

  it("turns on and back off", () => {
    setFloatBrowserOnClose(true);
    expect(getFloatBrowserOnClose()).toBe(true);
    setFloatBrowserOnClose(false);
    expect(getFloatBrowserOnClose()).toBe(false);
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
