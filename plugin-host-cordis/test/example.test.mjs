// Runs example/ in the host's real child runtime, with the host's side of the channel played by the test.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const CHILD_RUNTIME = new URL("../../apps/server/src/pluginHost/childRuntime.ts", import.meta.url);
const ENTRY = NodeURL.fileURLToPath(new URL("../example/index.mjs", import.meta.url));

NodeTest.test(
  "the example counts, asks example.clock, and its cleanup runs on deactivate",
  async () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runPluginChild } from ${JSON.stringify(CHILD_RUNTIME.href)}; runPluginChild();`,
      ],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    const storage = new Map();
    const logs = [];
    const waiting = new Map();
    const serveHostCall = ({ method, input }) => {
      switch (method) {
        case "storage.get":
          return storage.get(input.key) ?? null;
        case "storage.set":
          storage.set(input.key, input.value);
          return input.value;
        case "service.call":
          NodeAssert.deepEqual([input.service, input.method], ["example.clock", "now"]);
          return { text: "Now: fixed" };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    };
    child.on("message", (message) => {
      switch (message._tag) {
        case "HostCall":
          child.send({
            _tag: "HostCallSucceeded",
            requestId: message.requestId,
            value: serveHostCall(message),
          });
          break;
        case "Log":
          logs.push(message.message);
          break;
        default:
          waiting.get(message._tag)?.(message);
      }
    });
    const next = (tag) => new Promise((resolve) => waiting.set(tag, resolve));
    const invoke = async (requestId, handler, input) => {
      const reply = next("Succeeded");
      child.send({ _tag: "Invoke", requestId, handler, input });
      return (await reply).value;
    };

    try {
      const ready = next("Ready");
      const failed = next("ActivationFailed");
      child.send({
        _tag: "Activate",
        pluginId: "example.counter",
        version: "0.1.0",
        entryPath: ENTRY,
        capabilities: ["settings"],
        services: ["example.clock"],
        provides: [{ name: "example.counter", methods: ["increment", "get"] }],
      });
      const outcome = await Promise.race([ready, failed]);
      NodeAssert.equal(outcome._tag, "Ready", outcome.message);
      NodeAssert.deepEqual(outcome.provided, [
        { name: "example.counter", methods: ["increment", "get"] },
      ]);

      const call = (requestId, method, input) =>
        invoke(requestId, `service:example.counter:${method}`, { input, caller: "t3:user" });
      NodeAssert.deepEqual(await call(1, "increment", {}), { value: 1, time: "Now: fixed" });
      NodeAssert.deepEqual(await call(2, "increment", { by: 4 }), { value: 5, time: "Now: fixed" });
      NodeAssert.deepEqual(await call(3, "get", null), { value: 5 });

      const deactivated = next("Deactivated");
      const exited = NodeEvents.once(child, "exit");
      child.send({ _tag: "Deactivate" });
      await deactivated;
      await exited;
      NodeAssert.deepEqual(logs, ["counter stopped"]);
      NodeAssert.equal(storage.get("stops"), 1);
    } finally {
      child.kill();
    }
  },
);
