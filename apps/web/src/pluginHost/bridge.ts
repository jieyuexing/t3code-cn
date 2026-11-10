import type { PluginHostErrorReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The host side of the `t3-view` handshake and port protocol; the page side ships with each view. */
export type BridgeErrorCode =
  | PluginHostErrorReason
  | "cancelled"
  | "busy"
  | "rate"
  | "too-deep"
  | "too-large"
  | "invalid";

/** A failed page call, carrying the code the page receives. */
export class BridgeCallError extends Schema.TaggedError<BridgeCallError>()("BridgeCallError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const isBridgeCallError = Schema.is(BridgeCallError);

const BRIDGE_MAX_MESSAGE_CHARS = 64 * 1024;
const BRIDGE_MAX_DEPTH = 32;
const BRIDGE_MAX_PENDING_CALLS = 16;
const BRIDGE_MAX_VIOLATIONS = 8;
const BRIDGE_PING_INTERVAL_MS = 5_000;
const HANDLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_CALL_ID = 2 ** 31 - 1;

export type BridgeTeardownReason = "unresponsive" | "violations";

function exceedsDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (depth >= BRIDGE_MAX_DEPTH) return true;
  return Object.values(value).some((child) => exceedsDepth(child, depth + 1));
}

/**
 * Answers `ready` messages from the frame's own window with one port, then serves page calls on it.
 * Returns a disposer that closes the port and stops listening.
 */
export function attachPluginViewBridge(options: {
  readonly frame: HTMLIFrameElement;
  readonly init: { readonly pluginId: string; readonly viewId: string; readonly title: string };
  readonly call: (handler: string, input: unknown) => Promise<unknown>;
  readonly onTeardown: (reason: BridgeTeardownReason) => void;
  readonly pingIntervalMs?: number;
}): () => void {
  let port: MessagePort | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pending = new Set<number>();
  let violations = 0;
  let ping = 0;
  let answeredPing = 0;

  const closeChannel = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    port?.close();
    port = null;
    pending = new Set();
  };
  const send = (channel: MessagePort, message: object) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no target origin
    channel.postMessage(JSON.stringify(message));
  };
  const fail = (reason: BridgeTeardownReason) => {
    closeChannel();
    options.onTeardown(reason);
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
      const raw = event.data;
      if (typeof raw !== "string") return violate("invalid");
      if (raw.length > BRIDGE_MAX_MESSAGE_CHARS) return violate("too-large");
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return violate("invalid");
      }
      const body = message as {
        _tag?: unknown;
        id?: unknown;
        n?: unknown;
        handler?: unknown;
        input?: unknown;
      };
      if (body._tag === "pong") {
        if (typeof body.n === "number") answeredPing = Math.max(answeredPing, body.n);
        return;
      }
      const id = body.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > MAX_CALL_ID) {
        return violate("invalid");
      }
      if (body._tag === "cancel") {
        if (pending.delete(id))
          reply({ _tag: "error", id, code: "cancelled", message: "Cancelled." });
        return;
      }
      if (body._tag !== "call" || typeof body.handler !== "string") return violate("invalid");
      if (!HANDLER_PATTERN.test(body.handler))
        return refuse(id, "invalid", "Invalid handler name.");
      if (pending.has(id)) return refuse(id, "invalid", "Call id is already in use.");
      if (exceedsDepth(body.input, 0))
        return refuse(id, "too-deep", "The input is nested too deeply.");
      if (pending.size >= BRIDGE_MAX_PENDING_CALLS) {
        reply({ _tag: "error", id, code: "busy", message: "Too many calls are running." });
        return;
      }
      pending.add(id);
      options.call(body.handler, body.input ?? null).then(
        (value) => {
          if (!pending.delete(id)) return;
          const encoded = JSON.stringify({ _tag: "result", id, value: value ?? null });
          if (encoded.length > BRIDGE_MAX_MESSAGE_CHARS) {
            reply({ _tag: "error", id, code: "too-large", message: "The result is too large." });
          } else if (port === mine) {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no target origin
            mine.postMessage(encoded);
          }
        },
        (error: unknown) => {
          if (!pending.delete(id)) return;
          reply({
            _tag: "error",
            id,
            code: isBridgeCallError(error) ? error.code : "call-failed",
            message: error instanceof Error ? error.message : "The call failed.",
          });
        },
      );
    };

    send(mine, { _tag: "init", ...options.init });
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
  return () => {
    window.removeEventListener("message", onWindowMessage);
    closeChannel();
  };
}
