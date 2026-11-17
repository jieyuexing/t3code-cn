// The host's rules for what a plugin page may send over its `t3-view` port. `bridge.ts` serves the port
// with them, and `testkit/` lends the same functions to plugin tests. Nothing here may import: plugin
// repos load this file with plain Node, so it uses only erasable TypeScript.

const BRIDGE_MAX_MESSAGE_CHARS = 64 * 1024;
const BRIDGE_MAX_DEPTH = 32;
const BRIDGE_MAX_PENDING_CALLS = 16;
export const BRIDGE_MAX_VIOLATIONS = 8;
const HANDLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SERVICE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HOST_METHOD_MAX_CHARS = 64;
const MAX_CALL_ID = 2 ** 31 - 1;

/** The plugin handler a page's `call` reaches: the page names the bare handler, the host adds the view's prefix. */
export const viewHandlerName = (viewId: string, handler: string) => `view:${viewId}:${handler}`;

function exceedsDepth(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (depth >= BRIDGE_MAX_DEPTH) return true;
  return Object.values(value).some((child) => exceedsDepth(child, depth + 1));
}

/** What a page asks the host to run once the message has passed every check. */
export type BridgeCall =
  | { readonly kind: "call"; readonly handler: string; readonly input: unknown }
  | {
      readonly kind: "callService";
      readonly service: string;
      readonly method: string;
      readonly input: unknown;
    }
  | { readonly kind: "callHost"; readonly method: string; readonly input: unknown };

/** The host's answer to one page message; `violation` outcomes count towards tearing the page down. */
export type BridgeOutcome =
  | { readonly _tag: "run"; readonly id: number; readonly call: BridgeCall }
  | { readonly _tag: "pong"; readonly n: unknown }
  | { readonly _tag: "ignored" }
  | { readonly _tag: "cancelled"; readonly id: number }
  | { readonly _tag: "busy"; readonly id: number }
  | { readonly _tag: "violation"; readonly reason: "invalid" | "too-large" }
  | {
      readonly _tag: "refused";
      readonly id: number;
      readonly code: "invalid" | "too-deep";
      readonly message: string;
    };

/** What a call message names: a handler, a service method or a host method; `null` if it is none of them. */
function callOf(
  body: Readonly<Record<string, unknown>>,
): BridgeCall | { readonly refusal: string } | null {
  const input = body.input ?? null;
  if (body._tag === "call" && typeof body.handler === "string") {
    return HANDLER_PATTERN.test(body.handler)
      ? { kind: "call", handler: body.handler, input }
      : { refusal: "Invalid handler name." };
  }
  if (
    body._tag === "callService" &&
    typeof body.service === "string" &&
    typeof body.method === "string"
  ) {
    return SERVICE_PATTERN.test(body.service) && METHOD_PATTERN.test(body.method)
      ? { kind: "callService", service: body.service, method: body.method, input }
      : { refusal: "Invalid service or method name." };
  }
  if (
    body._tag === "callHost" &&
    typeof body.method === "string" &&
    body.method.length <= HOST_METHOD_MAX_CHARS
  ) {
    return { kind: "callHost", method: body.method, input };
  }
  return null;
}

/**
 * Judges the messages of one page connection, in the order the host does: size, JSON, id, name,
 * id reuse, nesting, then the number of calls in flight. A call that comes back `run` is in flight
 * until `finish` or `drop` releases it.
 */
export function createBridgeGate() {
  let pending = new Set<number>();
  return {
    admit(raw: unknown): BridgeOutcome {
      if (typeof raw !== "string") return { _tag: "violation", reason: "invalid" };
      if (raw.length > BRIDGE_MAX_MESSAGE_CHARS) return { _tag: "violation", reason: "too-large" };
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return { _tag: "violation", reason: "invalid" };
      }
      if (typeof message !== "object" || message === null) {
        return { _tag: "violation", reason: "invalid" };
      }
      const body = message as Readonly<Record<string, unknown>>;
      if (body._tag === "pong") return { _tag: "pong", n: body.n };
      const id = body.id;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > MAX_CALL_ID) {
        return { _tag: "violation", reason: "invalid" };
      }
      if (body._tag === "cancel") {
        return pending.delete(id) ? { _tag: "cancelled", id } : { _tag: "ignored" };
      }
      const call = callOf(body);
      if (call === null) return { _tag: "violation", reason: "invalid" };
      if ("refusal" in call) {
        return { _tag: "refused", id, code: "invalid", message: call.refusal };
      }
      if (pending.has(id)) {
        return { _tag: "refused", id, code: "invalid", message: "Call id is already in use." };
      }
      if (exceedsDepth(body.input, 0)) {
        return {
          _tag: "refused",
          id,
          code: "too-deep",
          message: "The input is nested too deeply.",
        };
      }
      if (pending.size >= BRIDGE_MAX_PENDING_CALLS) return { _tag: "busy", id };
      pending.add(id);
      return { _tag: "run", id, call };
    },
    /** The `result` message for a call that finished, or `null` if it is too large for the page; `undefined` if the call was already released. */
    finish(id: number, value: unknown): string | null | undefined {
      if (!pending.delete(id)) return undefined;
      const encoded = JSON.stringify({ _tag: "result", id, value: value ?? null });
      return encoded.length > BRIDGE_MAX_MESSAGE_CHARS ? null : encoded;
    },
    /** Releases a call that failed; `false` if it was already released. */
    drop: (id: number) => pending.delete(id),
    reset: () => {
      pending = new Set();
    },
  };
}
