// @effect-diagnostics nodeBuiltinImport:off - The plugin child runs outside any Effect runtime and loads the plugin with a plain dynamic import.
// Runs one plugin in its own process; the host starts it with the hidden `__plugin-host` command.
import * as NodeURL from "node:url";

import type { Json, PluginChildMessage, PluginHostMessage } from "./PluginIpc.ts";

interface PluginContext {
  readonly pluginId: string;
  readonly log: Record<"debug" | "info" | "warn" | "error", (...parts: Array<unknown>) => void>;
  readonly handle: (name: string, fn: (input: Json) => unknown) => void;
  readonly services: Readonly<
    Record<string, Readonly<Record<string, (input?: Json) => Promise<Json>>>>
  >;
  readonly provide: (
    name: string,
    methods: Readonly<Record<string, (input: Json, meta: { readonly caller: string }) => unknown>>,
  ) => void;
  settings?: { readonly get: (key: string) => Promise<Json> };
  storage?: {
    readonly get: (key: string) => Promise<Json>;
    readonly set: (key: string, value: Json) => Promise<Json>;
  };
}

interface PluginModule {
  readonly activate?: (context: PluginContext) => unknown;
  readonly default?: (context: PluginContext) => unknown;
  readonly deactivate?: () => unknown;
}

const messageText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export function runPluginChild() {
  const send = (message: PluginChildMessage) => process.send?.(message);
  const handlers = new Map<string, (input: Json) => unknown>();
  const hostCalls = new Map<
    number,
    { readonly resolve: (value: Json) => void; readonly reject: (error: Error) => void }
  >();
  let nextHostCall = 1;
  let pluginModule: PluginModule | undefined;

  const provided = new Map<string, Array<string>>();

  const hostCall = (
    method: "settings.get" | "storage.get" | "storage.set" | "service.call",
    input: Json,
  ) =>
    new Promise<Json>((resolve, reject) => {
      const requestId = nextHostCall++;
      hostCalls.set(requestId, { resolve, reject });
      send({ _tag: "HostCall", requestId, method, input });
    });

  const log =
    (level: "debug" | "info" | "warn" | "error") =>
    (...parts: Array<unknown>) =>
      send({
        _tag: "Log",
        level,
        message: parts
          .map((part) => String(part))
          .join(" ")
          .slice(0, 4000),
      });

  const buildContext = (message: Extract<PluginHostMessage, { _tag: "Activate" }>) => {
    const context: PluginContext = {
      pluginId: message.pluginId,
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
      handle: (name, fn) => {
        handlers.set(name, fn);
      },
      provide: (name, methods) => {
        provided.set(name, Object.keys(methods));
        for (const [method, fn] of Object.entries(methods))
          handlers.set(`service:${name}:${method}`, (call) => {
            const { input, caller } = call as { input: Json; caller: string };
            return fn(input, { caller });
          });
      },
      services: Object.fromEntries(
        message.services.map((service) => [
          service,
          new Proxy(
            {},
            {
              get: (_target, method) =>
                typeof method === "string"
                  ? (input?: Json) =>
                      hostCall("service.call", { service, method, input: input ?? null })
                  : undefined,
            },
          ),
        ]),
      ),
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

  const activate = async (message: Extract<PluginHostMessage, { _tag: "Activate" }>) => {
    try {
      pluginModule = (await import(NodeURL.pathToFileURL(message.entryPath).href)) as PluginModule;
      const run = pluginModule.activate ?? pluginModule.default;
      if (typeof run !== "function") throw new Error("The entry exports no activate function.");
      await run(buildContext(message));
      send({
        _tag: "Ready",
        handlers: [...handlers.keys()],
        provided: [...provided].map(([name, methods]) => ({ name, methods })),
      });
    } catch (error) {
      send({ _tag: "ActivationFailed", message: messageText(error) });
    }
  };

  const invoke = async ({
    requestId,
    handler,
    input,
  }: Extract<PluginHostMessage, { _tag: "Invoke" }>) => {
    try {
      const fn = handlers.get(handler);
      if (!fn) throw new Error(`No handler named ${handler}.`);
      const value = (await fn(input)) as Json | undefined;
      send({ _tag: "Succeeded", requestId, value: value === undefined ? null : value });
    } catch (error) {
      send({ _tag: "Failed", requestId, message: messageText(error) });
    }
  };

  const deactivate = async () => {
    try {
      await pluginModule?.deactivate?.();
    } finally {
      send({ _tag: "Deactivated" });
      process.exit(0);
    }
  };

  process.on("message", (message: PluginHostMessage) => {
    switch (message._tag) {
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
}
