import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readShareChoices, saveShareChoices } from "./usageShareChoices";

const key = "t3code:usage-share-rows:v1";
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => {
        values.set(name, value);
      },
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("share image row choices", () => {
  it("round-trips the user's ticks", () => {
    expect(readShareChoices()).toEqual({});
    saveShareChoices({ '["claude","claude-opus-5-5",null]': false });
    expect(readShareChoices()).toEqual({ '["claude","claude-opus-5-5",null]': false });
  });

  it.each(["not-json", '{"a":"yes"}', "[true]"])("reads %s as no choices", (value) => {
    values.set(key, value);
    expect(readShareChoices()).toEqual({});
  });

  it("falls back to no choices when storage throws, and does not throw on save", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readShareChoices()).toEqual({});
    expect(() => saveShareChoices({ a: true })).not.toThrow();
  });
});
