import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PluginHostError,
  type EnvironmentId,
  type PluginId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { useStableCallback } from "../hooks/useStableCallback";
import { usePreparedConnection } from "../state/session";
import {
  attachPluginViewBridge,
  BridgeCallError,
  type BridgeErrorCode,
  type PluginFocus,
} from "./bridge";
import { useHostApi } from "./useHostApi";
import { pluginHostFailureMessage, usePluginHostCall } from "./usePluginHost";
import { usePluginViewContext } from "./viewContext";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const isPluginHostError = Schema.is(PluginHostError);

/** The value of a successful call; a failure reaches the page with the host's reason as its code. */
async function settle(pending: ReturnType<ReturnType<typeof usePluginHostCall>>) {
  const result = await pending;
  if (result._tag === "Success") return result.value.value;
  const error = squashAtomCommandFailure(result);
  const code: BridgeErrorCode = isPluginHostError(error) ? error.reason : "call-failed";
  throw new BridgeCallError({ code, message: pluginHostFailureMessage(result) });
}

type FrameState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly src: string }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "silent" };

/**
 * One sandboxed plugin page. It loads the page from the server, serves its `t3-view` bridge, and
 * stays out of the document while the tab is hidden: the parent mounts it only when visible.
 */
export function PluginViewFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: PluginId;
  readonly viewId: string;
  readonly title: string;
  readonly generation: number;
  /** The capabilities the plugin's manifest declares; they decide what `callHost` reaches. */
  readonly capabilities: ReadonlyArray<string>;
  /** The thread's working directory, shown to the page as its `context`. */
  readonly cwd: string | null;
  /** The file or folder the thread's file panel last stood on, shown to the page as its `context`. */
  readonly focus: PluginFocus | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly onReload: () => void;
}) {
  const {
    environmentId,
    pluginId,
    viewId,
    title,
    generation,
    capabilities,
    cwd,
    focus,
    threadRef,
    onReload,
  } = props;
  const call = useStableCallback(usePluginHostCall(environmentId));
  const callHost = useStableCallback(useHostApi({ environmentId, capabilities, threadRef }));
  const context = usePluginViewContext(cwd, focus);
  const contextRef = useRef(context);
  const bridgeRef = useRef<{ readonly pushContext: () => void } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the page's open bridge that the thread's directory, its file focus or the theme changed
  useEffect(() => {
    contextRef.current = context;
    bridgeRef.current?.pushContext();
  }, [context]);
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const [state, setState] = useState<FrameState>({ _tag: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the view's page URL from the server for this generation
  useEffect(() => {
    if (httpBaseUrl === null) return;
    let cancelled = false;
    void call({ _tag: "readView", pluginId, viewId, generation }).then((result) => {
      if (cancelled) return;
      if (result._tag !== "Success") {
        setState({ _tag: "failed", message: pluginHostFailureMessage(result) });
        return;
      }
      const src = resolveAssetUrl(httpBaseUrl, (result.value.value as { url: string }).url);
      setState(
        src === null
          ? { _tag: "failed", message: "The server returned an invalid page address." }
          : { _tag: "ready", src },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [call, httpBaseUrl, pluginId, viewId, generation]);

  // The page must announce itself within the timeout, or the view is shown as not started.
  // A ref callback whose identity changed would be detached and attached again on a re-render,
  // closing the page's port, so it is held stable.
  const attachFrame = useStableCallback((frame: HTMLIFrameElement | null) => {
    if (frame === null) return;
    const handshakeTimer = setTimeout(() => setState({ _tag: "silent" }), HANDSHAKE_TIMEOUT_MS);
    const bridge = attachPluginViewBridge({
      frame,
      init: { pluginId, viewId, title },
      context: () => contextRef.current,
      callHost: (method, input) => callHost(method, input),
      onTeardown: () => setState({ _tag: "stopped" }),
      call: (handler, input) =>
        settle(
          call({
            _tag: "invoke",
            pluginId,
            handler: `view:${viewId}:${handler}`,
            input: input as never,
          }),
        ),
      callService: (service, method, input) =>
        settle(call({ _tag: "callViewService", pluginId, service, method, input: input as never })),
    });
    const clearHandshake = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) clearTimeout(handshakeTimer);
    };
    window.addEventListener("message", clearHandshake);
    bridgeRef.current = bridge;
    return () => {
      bridgeRef.current = null;
      clearTimeout(handshakeTimer);
      window.removeEventListener("message", clearHandshake);
      bridge.dispose();
    };
  });

  if (state._tag === "ready") {
    return (
      <iframe
        ref={attachFrame}
        src={state.src}
        title={title}
        // Omitting allow-same-origin keeps the page apart from the session.
        sandbox="allow-scripts allow-forms"
        className="block size-full border-0"
      />
    );
  }
  return (
    <div className="flex size-full flex-col items-start justify-center gap-2 px-4 text-xs text-muted-foreground">
      {state._tag === "loading" ? <p>Loading view…</p> : null}
      {state._tag === "failed" ? <p>Could not load the view. {state.message}</p> : null}
      {state._tag === "silent" ? <p>The view did not start.</p> : null}
      {state._tag === "stopped" ? <p>The view stopped responding and was unmounted.</p> : null}
      {state._tag === "loading" ? null : (
        <Button size="xs" variant="outline" onClick={onReload}>
          Reload view
        </Button>
      )}
    </div>
  );
}
