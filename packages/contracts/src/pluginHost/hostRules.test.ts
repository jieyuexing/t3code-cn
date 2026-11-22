import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { cacheEvictions, pluginErrorCode, pluginErrorText } from "./hostRules.ts";
import { PluginHostError } from "./rpc.ts";

const encodeError = Schema.encodeSync(PluginHostError);
const decodeError = Schema.decodeSync(PluginHostError);

describe("plugin host rules", () => {
  it("drops the least recently used cache entries until the cache fits, never the one just written", () => {
    const index = new Map([
      ["a", { bytes: 100, order: 1 }],
      ["b", { bytes: 100, order: 3 }],
      ["c", { bytes: 100, order: 2 }],
    ]);
    expect(cacheEvictions(index, "b", 250)).toEqual(["a"]);
    expect(cacheEvictions(index, "b", 100)).toEqual(["a", "c"]);
    expect(cacheEvictions(index, "a", 100)).toEqual([]);
  });

  it("takes a code only when it is 1–64 characters of letters, digits and _ . -", () => {
    expect(pluginErrorCode({ code: "a.b_c-D9" })).toBe("a.b_c-D9");
    for (const code of ["", "x".repeat(65), "not a code", 404, undefined]) {
      expect(pluginErrorCode({ code })).toBeUndefined();
    }
    expect(pluginErrorCode(null)).toBeUndefined();
    expect(pluginErrorCode("code")).toBeUndefined();
  });

  it("reads the message of an error or of a structured error, and cuts it", () => {
    expect(pluginErrorText(new Error("boom"))).toBe("boom");
    expect(pluginErrorText({ code: "x", message: "slow down" })).toBe("slow down");
    expect(pluginErrorText("plain")).toBe("plain");
    expect(pluginErrorText(new Error("x".repeat(3000)))).toHaveLength(2000);
  });

  it("keeps a plugin's code on the host error over the wire and refuses one that does not qualify", () => {
    const wire = encodeError(
      new PluginHostError({ reason: "call-failed", detail: "failed: boom", pluginCode: "a.b" }),
    );
    expect(decodeError(wire).pluginCode).toBe("a.b");
    expect(() => decodeError({ ...wire, pluginCode: "not a code" })).toThrow();
  });
});
