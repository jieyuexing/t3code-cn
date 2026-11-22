// A host for plugin tests: the page-side calls of a view go through the host's own bridge rules and
// `callHost` capability check, then to the handlers the plugin registered. Plugin repos load this file
// with plain Node (see fork-notes/plugin-host.md), so everything it imports must stay import-free and erasable.
import { createBridgeGate, viewHandlerName } from "../bridgeRules.ts";
import { hostMethodDenial } from "../hostMethods.ts";
import {
  injectionProblem,
  pluginErrorCode,
  pluginErrorText,
} from "../../../../../packages/contracts/src/pluginHost/hostRules.ts";

export { createPluginContext } from "./pluginContext.ts";
export type { PluginContextOptions, ServiceProvider } from "./pluginContext.ts";

/**
 * A call the host refused or the plugin failed; `code` is what the page's call would have been rejected with
 * and `pluginCode` the `code` the plugin's own error carried, when it had a usable one.
 */
// @effect-diagnostics-next-line extendsNativeError:off - Plugin repos run this outside Effect and catch it as a plain Error with a `code`.
export class ViewCallError extends Error {
  readonly code: string;
  declare readonly pluginCode?: string;
  constructor(message: string, code: string, pluginCode?: string) {
    super(message);
    this.code = code;
    if (pluginCode !== undefined) this.pluginCode = pluginCode;
  }
}

type Run = (input: unknown) => unknown;

export interface ViewHostOptions {
  readonly viewId: string;
  /** What the plugin registered with `context.handle`, by its full name such as `view:panel:open`. */
  readonly handlers: ReadonlyMap<string, Run>;
  /** The capabilities in the plugin's manifest. */
  readonly capabilities: ReadonlyArray<string>;
  /** Stand-ins for the host methods a view calls; reached only when the host would let the plugin through. */
  readonly host?: Readonly<Record<string, Run>>;
  /** A stand-in for the services the plugin injects. */
  readonly service?: (service: string, method: string, input: unknown) => unknown;
  /** With `inject`, a service call outside it is refused the way the host refuses it; `pluginId` names the plugin in that sentence. */
  readonly pluginId?: string;
  readonly inject?: ReadonlyArray<string>;
}

export function createViewHost(options: ViewHostOptions) {
  const gate = createBridgeGate();
  let nextId = 1;

  const send = async (body: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const outcome = gate.admit(JSON.stringify({ ...body, id }));
    switch (outcome._tag) {
      case "violation":
        throw new ViewCallError(
          `The host rejected the message (${outcome.reason}).`,
          outcome.reason,
        );
      case "refused":
        throw new ViewCallError(outcome.message, outcome.code);
      case "busy":
        throw new ViewCallError("Too many calls are running.", "busy");
      case "run":
        break;
      default:
        throw new ViewCallError("The message was not a call.", "invalid");
    }
    const { call } = outcome;
    try {
      const value = await (() => {
        if (call.kind === "call") {
          const name = viewHandlerName(options.viewId, call.handler);
          const run = options.handlers.get(name);
          if (run === undefined)
            throw new ViewCallError(`No handler named ${name}.`, "call-failed");
          return run(call.input);
        }
        if (call.kind === "callHost") {
          const denial = hostMethodDenial(call.method, options.capabilities);
          if (denial !== null) throw new ViewCallError(denial, "denied");
          const run = options.host?.[call.method];
          if (run === undefined) {
            throw new ViewCallError(
              `The test gives no stand-in for host method ${call.method}.`,
              "call-failed",
            );
          }
          return run(call.input);
        }
        if (options.inject !== undefined) {
          const notInjected = injectionProblem(
            options.pluginId ?? "the plugin",
            options.inject,
            call.service,
          );
          if (notInjected !== undefined) throw new ViewCallError(notInjected, "not-found");
        }
        if (options.service === undefined) {
          throw new ViewCallError(
            `The test gives no stand-in for service ${call.service}.`,
            "not-found",
          );
        }
        return options.service(call.service, call.method, call.input);
      })();
      const encoded = gate.finish(id, value);
      if (encoded === null) throw new ViewCallError("The result is too large.", "too-large");
      return (JSON.parse(encoded as string) as { value: unknown }).value;
    } catch (error) {
      gate.drop(id);
      if (error instanceof ViewCallError) throw error;
      throw new ViewCallError(pluginErrorText(error), "call-failed", pluginErrorCode(error));
    }
  };

  return {
    call: (handler: string, input?: unknown) => send({ _tag: "call", handler, input }),
    callService: (service: string, method: string, input?: unknown) =>
      send({ _tag: "callService", service, method, input }),
    callHost: (method: string, input?: unknown) => send({ _tag: "callHost", method, input }),
  };
}
