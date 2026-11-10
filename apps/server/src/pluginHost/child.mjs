// Runs one plugin in its own process. Plain JS because the host starts it with `node child.mjs`.
import * as NodeURL from "node:url";

const send = (message) => process.send?.(message);
const handlers = new Map();
const hostCalls = new Map();
let nextHostCall = 1;
let module;

const hostCall = (method, input) =>
  new Promise((resolve, reject) => {
    const requestId = nextHostCall++;
    hostCalls.set(requestId, { resolve, reject });
    send({ _tag: "HostCall", requestId, method, input });
  });

const log =
  (level) =>
  (...parts) =>
    send({
      _tag: "Log",
      level,
      message: parts
        .map((part) => String(part))
        .join(" ")
        .slice(0, 4000),
    });

const buildContext = (message) => {
  const context = {
    pluginId: message.pluginId,
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    handle: (name, fn) => {
      handlers.set(name, fn);
    },
  };
  if (message.capabilities.includes("settings")) {
    context.settings = { get: (key) => hostCall("settings.get", { key }) };
    context.storage = {
      get: (key) => hostCall("storage.get", { key }),
      set: (key, value) => hostCall("storage.set", { key, value }),
    };
  }
  return context;
};

const activate = async (message) => {
  try {
    module = await import(NodeURL.pathToFileURL(message.entryPath).href);
    const run = module.activate ?? module.default;
    if (typeof run !== "function") throw new Error("The entry exports no activate function.");
    await run(buildContext(message));
    send({ _tag: "Ready", handlers: [...handlers.keys()] });
  } catch (error) {
    send({ _tag: "ActivationFailed", message: String(error?.message ?? error).slice(0, 2000) });
  }
};

const invoke = async ({ requestId, handler, input }) => {
  try {
    const fn = handlers.get(handler);
    if (!fn) throw new Error(`No handler named ${handler}.`);
    const value = await fn(input);
    send({ _tag: "Succeeded", requestId, value: value === undefined ? null : value });
  } catch (error) {
    send({ _tag: "Failed", requestId, message: String(error?.message ?? error).slice(0, 2000) });
  }
};

const deactivate = async () => {
  try {
    await module?.deactivate?.();
  } finally {
    send({ _tag: "Deactivated" });
    process.exit(0);
  }
};

process.on("message", (message) => {
  switch (message?._tag) {
    case "Activate":
      void activate(message);
      break;
    case "Invoke":
      void invoke(message);
      break;
    case "Deactivate":
      void deactivate();
      break;
    case "HostCallSucceeded":
      hostCalls.get(message.requestId)?.resolve(message.value);
      hostCalls.delete(message.requestId);
      break;
    case "HostCallFailed":
      hostCalls.get(message.requestId)?.reject(new Error(message.message));
      hostCalls.delete(message.requestId);
      break;
  }
});
process.on("disconnect", () => process.exit(0));
