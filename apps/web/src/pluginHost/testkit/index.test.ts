// @effect-diagnostics nodeBuiltinImport:off - Runs the testkit in a bare Node process, the way plugin repos load it.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { createBridgeGate } from "../bridgeRules.ts";
import { createViewHost, ViewCallError } from "./index.ts";

const handlers = new Map<string, (input: unknown) => unknown>([
  ["view:panel:open", (input) => ({ opened: input })],
  ["view:panel:big", () => "x".repeat(70_000)],
]);

const host = (capabilities: ReadonlyArray<string> = []) =>
  createViewHost({
    viewId: "panel",
    handlers,
    capabilities,
    host: { "t3.addToComposer": () => null, "vcs.status": () => ({ isRepo: true }) },
  });

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof ViewCallError ? error.code : error),
  );

describe("plugin test host", () => {
  it("lets a bare handler name through and adds the view prefix itself", async () => {
    expect(await host().call("open", { name: "a" })).toEqual({ opened: { name: "a" } });
  });

  it("refuses a handler name that already carries the prefix, as the real bridge does", async () => {
    expect(await rejection(host().call("view:panel:open"))).toBe("invalid");
  });

  it("fails a call the plugin never registered under the prefixed name", async () => {
    expect(await rejection(host().call("missing"))).toBe("call-failed");
  });

  it("rejects oversized requests and results and over-nested input", async () => {
    expect(await rejection(host().call("open", "x".repeat(70_000)))).toBe("too-large");
    expect(await rejection(host().call("big"))).toBe("too-large");
    const nested = Array.from({ length: 40 }).reduce<unknown>((inner) => ({ inner }), 1);
    expect(await rejection(host().call("open", nested))).toBe("too-deep");
  });

  it("denies host methods the manifest has no capability for, and unknown ones", async () => {
    expect(
      await rejection(host(["host.vcs-read"]).callHost("t3.addToComposer", { text: "a" })),
    ).toBe("denied");
    expect(await rejection(host(["host.composer"]).callHost("t3.nothing"))).toBe("denied");
    expect(await host(["host.composer"]).callHost("t3.addToComposer", { text: "a" })).toBeNull();
    expect(await host(["host.vcs-read"]).callHost("vcs.status", { cwd: "/r" })).toEqual({
      isRepo: true,
    });
  });
});

describe("bridge gate", () => {
  const call = (id: number) => JSON.stringify({ _tag: "call", id, handler: "open", input: null });

  it("holds a call id until it finishes and refuses a second call over 16 in flight", () => {
    const gate = createBridgeGate();
    expect(gate.admit(call(1))._tag).toBe("run");
    expect(gate.admit(call(1))).toMatchObject({
      _tag: "refused",
      message: "Call id is already in use.",
    });
    for (let id = 2; id <= 16; id += 1) expect(gate.admit(call(id))._tag).toBe("run");
    expect(gate.admit(call(17))._tag).toBe("busy");
    expect(gate.finish(1, "done")).toBe('{"_tag":"result","id":1,"value":"done"}');
    expect(gate.admit(call(17))._tag).toBe("run");
  });

  it("treats a cancel of a call in flight as cancelled and of an unknown one as ignored", () => {
    const gate = createBridgeGate();
    gate.admit(call(1));
    expect(gate.admit(JSON.stringify({ _tag: "cancel", id: 1 }))._tag).toBe("cancelled");
    expect(gate.admit(JSON.stringify({ _tag: "cancel", id: 1 }))._tag).toBe("ignored");
  });

  it("counts malformed messages as violations", () => {
    const gate = createBridgeGate();
    for (const raw of [
      1,
      "{",
      "null",
      JSON.stringify({ _tag: "call", id: 0 }),
      JSON.stringify({ _tag: "x", id: 1 }),
    ]) {
      expect(gate.admit(raw)).toEqual({ _tag: "violation", reason: "invalid" });
    }
  });
});

describe("loading by plugin repos", () => {
  it("loads with plain Node, without the repo's module resolution", () => {
    const url = NodeURL.pathToFileURL(new URL("./index.ts", import.meta.url).pathname).href;
    const script = `import(${JSON.stringify(url)}).then((m) => m.createViewHost({ viewId: "p", handlers: new Map(), capabilities: [] }).call("a b").catch((e) => console.log(e.code)))`;
    expect(NodeChildProcess.execFileSync(process.execPath, ["-e", script]).toString().trim()).toBe(
      "invalid",
    );
  });
});
