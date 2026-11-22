// @effect-diagnostics nodeBuiltinImport:off - Runs the testkit in a bare Node process, the way plugin repos load it.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { createBridgeGate } from "../bridgeRules.ts";
import { createPluginContext, createViewHost, ViewCallError } from "./index.ts";

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

describe("plugin errors seen from a view", () => {
  const failing = (thrown: unknown) =>
    createViewHost({
      viewId: "panel",
      handlers: new Map([
        [
          "view:panel:fail",
          () => {
            throw thrown;
          },
        ],
      ]),
      capabilities: [],
    })
      .call("fail")
      .then(
        () => Promise.reject(new Error("the call should have failed")),
        (error: unknown) => error as ViewCallError,
      );

  it("carries the plugin's own code beside the host's, and none when the code is unusable", async () => {
    const coded = await failing(Object.assign(new Error("no client"), { code: "missingClient" }));
    expect([coded.code, coded.pluginCode, coded.message]).toEqual([
      "call-failed",
      "missingClient",
      "no client",
    ]);
    const structured = await failing({ code: "rate.limited", message: "slow down" });
    expect([structured.pluginCode, structured.message]).toEqual(["rate.limited", "slow down"]);
    for (const code of ["", "x".repeat(65), "not a code", 404]) {
      const refused = await failing(Object.assign(new Error("boom"), { code }));
      expect([refused.code, refused.message]).toEqual(["call-failed", "boom"]);
      expect(refused).not.toHaveProperty("pluginCode");
    }
  });

  it("refuses a service the plugin does not inject with the host's sentence", async () => {
    const view = createViewHost({
      viewId: "panel",
      handlers: new Map(),
      capabilities: [],
      pluginId: "example.me",
      inject: ["example.clock"],
      service: () => "tick",
    });
    expect(await view.callService("example.clock", "now")).toBe("tick");
    const refused = await view.callService("example.other", "now").catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "not-found",
      message: "Plugin example.me does not declare a dependency on example.other.",
    });
  });
});

describe("plugin context", () => {
  const settingsContext = (extra: Partial<Parameters<typeof createPluginContext>[0]> = {}) =>
    createPluginContext({ pluginId: "example.me", capabilities: ["settings"], ...extra });
  const message = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error as Error).message,
    );

  it("offers storage and settings only with the settings capability, and a cache always", () => {
    expect(Object.keys(createPluginContext({ pluginId: "p", capabilities: [] }).context)).toEqual([
      "pluginId",
      "cache",
      "services",
    ]);
    expect(Object.keys(settingsContext().context)).toContain("storage");
  });

  it("refuses a storage value over 256 KiB and keeps the one that fits", async () => {
    const { context, storageKeys } = settingsContext();
    expect(await message(context.storage!.set("big", "x".repeat(256 * 1024 - 1)))).toBe(
      "The value is too large to store.",
    );
    await context.storage!.set("fits", "x".repeat(256 * 1024 - 2));
    expect(storageKeys()).toEqual(["fits"]);
    expect(await context.storage!.get("missing")).toBeNull();
  });

  it("refuses a cache entry over the per-value limit and evicts the least recently used", async () => {
    const { context, cacheKeys } = settingsContext({
      cacheLimits: { maxBytes: 300, maxValueBytes: 200 },
    });
    expect(await message(context.cache.set("big", "x".repeat(200)))).toBe(
      "The value is too large to cache.",
    );
    await context.cache.set("a", "x".repeat(100));
    await context.cache.set("b", "x".repeat(100));
    await context.cache.get("a");
    await context.cache.set("c", "x".repeat(100));
    expect(cacheKeys()).toEqual(["a", "c"]);
    expect(await context.cache.get("b")).toBeNull();
  });

  it("rejects a request without a key and an undeclared setting with the host's sentences", async () => {
    const { context } = settingsContext({ settings: { name: "n" } });
    expect(await context.settings!.get("name")).toBe("n");
    expect(await message(context.settings!.get("other"))).toBe("Unknown setting other.");
    expect(await message(context.storage!.get(undefined as never))).toBe(
      "The request needs a key.",
    );
  });

  it("reaches only the services it injects and counts a write only after a success", async () => {
    const { context, dataRevision } = settingsContext({
      inject: ["example.clock"],
      providers: {
        "example.clock": {
          plugin: "example.clock-plugin",
          methods: {
            now: { readOnly: true, run: () => "tick" },
            reset: { run: () => null },
            fail: {
              run: () => {
                throw new Error("boom");
              },
            },
          },
        },
      },
    });
    expect(Object.keys(context.services)).toEqual(["example.clock"]);
    const clock = context.services["example.clock"] as Record<string, () => Promise<unknown>>;
    expect(await clock.now!()).toBe("tick");
    expect(dataRevision("example.clock-plugin")).toBe(0);
    expect(await message(clock.fail!())).toBe("example.clock (example.clock-plugin): failed: boom");
    expect(await message(clock.nothing!())).toBe(
      "The service example.clock has no method nothing.",
    );
    expect(dataRevision("example.clock-plugin")).toBe(0);
    await clock.reset!();
    expect(dataRevision("example.clock-plugin")).toBe(1);
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
    const script = `import(${JSON.stringify(url)}).then(async (m) => {
      const failure = await m.createViewHost({ viewId: "p", handlers: new Map(), capabilities: [] }).call("a b").catch((e) => e.code);
      const stored = await m.createPluginContext({ pluginId: "p", capabilities: ["settings"] }).context.storage.set("k", "x".repeat(256 * 1024)).catch((e) => e.message);
      console.log(failure, stored);
    })`;
    expect(NodeChildProcess.execFileSync(process.execPath, ["-e", script]).toString().trim()).toBe(
      "invalid The value is too large to store.",
    );
  });
});
