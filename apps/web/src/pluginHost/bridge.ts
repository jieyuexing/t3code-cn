import type { PluginHostErrorReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BRIDGE_MAX_VIOLATIONS, createBridgeGate, type BridgeCall } from "./bridgeRules.ts";

/** The host side of the `t3-view` handshake and port protocol; the page side ships with each view. */
export type BridgeErrorCode =
  | PluginHostErrorReason
  | "cancelled"
  | "denied"
  | "busy"
  | "rate"
  | "too-deep"
  | "too-large"
  | "invalid";

/** The file or folder tab the thread's panel last stood on. */
export interface PluginFocus {
  readonly path: string;
  readonly kind: "folder" | "file";
}

/** What the host tells a page about where it is shown: the thread's directory, its file panel's focus and T3's theme. */
export interface PluginViewContext {
  readonly cwd: string | null;
  readonly focus: PluginFocus | null;
  readonly theme: {
    readonly scheme: "light" | "dark";
    readonly vars: Readonly<Record<string, string>>;
  };
}

/** A failed page call, carrying the code the page receives. */
export class BridgeCallError extends Schema.TaggedError<BridgeCallError>()("BridgeCallError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const isBridgeCallError = Schema.is(BridgeCallError);

const BRIDGE_PING_INTERVAL_MS = 5_000;

export type BridgeTeardownReason = "unresponsive" | "violations";

/**
 * Answers `ready` messages from the frame's own window with one port, then serves page calls on it.
 * `dispose` closes the port and stops listening; `pushContext` sends the page the context again
 * when it has changed since the page last got it; `pushChanged` tells it the plugin's data moved to a new revision.
 */
export function attachPluginViewBridge(options: {
  readonly frame: HTMLIFrameElement;
  readonly init: { readonly pluginId: string; readonly viewId: string; readonly title: string };
  readonly call: (handler: string, input: unknown) => Promise<unknown>;
  /** A call on a service the view's plugin injects; the plugin is the frame's, never the page's. */
  readonly callService: (service: string, method: string, input: unknown) => Promise<unknown>;
  /** A call on the host itself; the host decides what the plugin may reach. */
  readonly callHost: (method: string, input: unknown) => Promise<unknown>;
  readonly context: () => PluginViewContext;
  readonly onTeardown: (reason: BridgeTeardownReason) => void;
  readonly pingIntervalMs?: number;
}): {
  readonly dispose: () => void;
  readonly pushContext: () => void;
  readonly pushChanged: (revision: number) => void;
} {
  let port: MessagePort | null = null;
  let sentContext = "";
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const gate = createBridgeGate();
  let violations = 0;
  let ping = 0;
  let answeredPing = 0;

  const closeChannel = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    port?.close();
    port = null;
    gate.reset();
  };
  const send = (channel: MessagePort, message: object) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no target origin
    channel.postMessage(JSON.stringify(message));
  };
  const fail = (reason: BridgeTeardownReason) => {
    closeChannel();
    options.onTeardown(reason);
  };

  const runCall = (call: BridgeCall): Promise<unknown> => {
    switch (call.kind) {
      case "call":
        return options.call(call.handler, call.input);
      case "callService":
        return options.callService(call.service, call.method, call.input);
      case "callHost":
        return options.callHost(call.method, call.input);
    }
  };

  const connect = () => {
    closeChannel();
    const channel = new MessageChannel();
    const mine = channel.port1;
    port = mine;
    violations = 0;
    ping = 0;
    answeredPing = 0;
    const reply = (message: object) => {
      if (port === mine) send(mine, message);
    };
    const violate = (reason: string) => {
      reply({ _tag: "violation", reason });
      violations += 1;
      if (violations >= BRIDGE_MAX_VIOLATIONS) fail("violations");
    };
    const refuse = (id: number, code: BridgeErrorCode, message: string) => {
      reply({ _tag: "error", id, code, message });
      violate(code);
    };

    mine.onmessage = (event: MessageEvent) => {
      const outcome = gate.admit(event.data);
      switch (outcome._tag) {
        case "pong":
          if (typeof outcome.n === "number") answeredPing = Math.max(answeredPing, outcome.n);
          return;
        case "ignored":
          return;
        case "violation":
          return violate(outcome.reason);
        case "refused":
          return refuse(outcome.id, outcome.code, outcome.message);
        case "cancelled":
          reply({ _tag: "error", id: outcome.id, code: "cancelled", message: "Cancelled." });
          return;
        case "busy":
          reply({
            _tag: "error",
            id: outcome.id,
            code: "busy",
            message: "Too many calls are running.",
          });
          return;
        case "run":
          break;
      }
      const { id } = outcome;
      runCall(outcome.call).then(
        (value) => {
          const encoded = gate.finish(id, value);
          if (encoded === undefined) return;
          if (encoded === null) {
            reply({ _tag: "error", id, code: "too-large", message: "The result is too large." });
          } else if (port === mine) {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no target origin
            mine.postMessage(encoded);
          }
        },
        (error: unknown) => {
          if (!gate.drop(id)) return;
          reply({
            _tag: "error",
            id,
            code: isBridgeCallError(error) ? error.code : "call-failed",
            message: error instanceof Error ? error.message : "The call failed.",
          });
        },
      );
    };

    const context = options.context();
    sentContext = JSON.stringify(context);
    send(mine, { _tag: "init", ...options.init, context });
    options.frame.contentWindow?.postMessage({ type: "t3-view:connect" }, "*", [channel.port2]);
    pingTimer = setInterval(() => {
      if (ping > answeredPing) return fail("unresponsive");
      ping += 1;
      reply({ _tag: "ping", n: ping });
    }, options.pingIntervalMs ?? BRIDGE_PING_INTERVAL_MS);
  };

  const onWindowMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (
      event.source !== null &&
      event.source === options.frame.contentWindow &&
      data?.type === "t3-view:ready"
    ) {
      connect();
    }
  };
  window.addEventListener("message", onWindowMessage);
  return {
    dispose: () => {
      window.removeEventListener("message", onWindowMessage);
      closeChannel();
    },
    pushContext: () => {
      const context = options.context();
      const encoded = JSON.stringify(context);
      if (port === null || encoded === sentContext) return;
      sentContext = encoded;
      send(port, { _tag: "context", context });
    },
    pushChanged: (revision) => {
      if (port !== null) send(port, { _tag: "changed", revision });
    },
  };
}
