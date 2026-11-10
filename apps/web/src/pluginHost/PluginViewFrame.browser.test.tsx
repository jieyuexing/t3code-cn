import { PluginId } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import echoClockView from "../../../../plugin-host-examples/echo-clock/view.html?raw";
import { PluginViewFrame } from "./PluginViewFrame";

const fixture = vi.hoisted(() => ({
  pageUrl: "",
  calls: [] as unknown[],
  echoes: 0,
}));

vi.mock("../state/session", () => ({
  usePreparedConnection: () => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://environment.example.test" },
  }),
}));
vi.mock("./usePluginHost", () => ({
  pluginHostFailureMessage: () => "failed",
  usePluginHostCall: () => async (input: { _tag: string; handler?: string; input?: unknown }) => {
    fixture.calls.push(input);
    if (input._tag === "readView") {
      return AsyncResult.success({ value: { generation: 1, url: fixture.pageUrl, expiresAt: 0 } });
    }
    if (input.handler === "view:clock:now")
      return AsyncResult.success({ value: { text: "12:34:56" } });
    fixture.echoes += 1;
    return AsyncResult.success({
      value: { echo: (input.input as { message: string }).message, n: fixture.echoes },
    });
  },
}));

const environmentId = EnvironmentId.make("environment-a");
const pluginId = PluginId.make("example.echo-clock");

// A sandboxed page without allow-same-origin cannot be inspected, so the example page is
// extended with a script that clicks its button once enabled and reports what it shows.
const OBSERVER = `<script>
  const report = (what, text) => parent.postMessage({ type: "test-observe", what, text }, "*");
  window.addEventListener("message", (event) => {
    if (event.source === parent && event.data?.type === "test-click") document.getElementById("echo").click();
  });
  new MutationObserver(() => {
    const echo = document.getElementById("echo");
    if (!echo.disabled && !echo.dataset.clicked) {
      echo.dataset.clicked = "1";
      report("enabled", "");
      echo.click();
    }
    report("time", document.getElementById("time").textContent);
    report("reply", document.getElementById("reply").textContent);
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
</script>`;

function setup(html: string) {
  fixture.calls = [];
  fixture.echoes = 0;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  fixture.pageUrl = url;
  const seen: string[] = [];
  const listen = (event: MessageEvent) => {
    const data = event.data as { type?: string; what?: string; text?: string };
    if (data?.type === "test-observe") seen.push(`${data.what}:${data.text}`);
  };
  window.addEventListener("message", listen);
  return {
    seen,
    [Symbol.dispose]: () => {
      window.removeEventListener("message", listen);
      URL.revokeObjectURL(url);
    },
  };
}

const frameProps = {
  environmentId,
  pluginId,
  viewId: "clock",
  title: "Echo Clock",
  generation: 1,
  onReload: () => {},
};
const frame = <PluginViewFrame {...frameProps} />;

it("hands the page a port, sends its calls to the host with the view prefix and returns the results", async () => {
  using observed = setup(echoClockView.replace("</body>", `${OBSERVER}</body>`));
  await using screen = await render(frame, { router: false });

  // The page enables its button only after the host's `init`, so this proves the handshake.
  await vi.waitFor(() => expect(observed.seen).toContain("enabled:"));
  await vi.waitFor(() => expect(observed.seen).toContain("time:12:34:56"));
  expect(fixture.calls).toContainEqual({
    _tag: "invoke",
    pluginId,
    handler: "view:clock:now",
    input: null,
  });

  await vi.waitFor(() => expect(observed.seen).toContain('reply:{"echo":"hello","n":1}'));

  // The port survives a re-render: a second call still gets its answer.
  await screen.rerender(<PluginViewFrame {...frameProps} />);
  screen.container.querySelector("iframe")?.contentWindow?.postMessage({ type: "test-click" }, "*");
  await vi.waitFor(() => expect(observed.seen).toContain('reply:{"echo":"hello","n":2}'));
  expect(fixture.calls).toContainEqual({
    _tag: "invoke",
    pluginId,
    handler: "view:clock:echo",
    input: { message: "hello" },
  });
});

it("ignores a ready message that does not come from its own frame", async () => {
  using _page = setup("<!doctype html><title>silent</title>");
  await using screen = await render(frame, { router: false });
  await expect.element(screen.getByTitle("Echo Clock")).toBeVisible();
  using connections = vi.spyOn(globalThis, "MessageChannel");

  // Listeners run in registration order, so once this one sees the message the bridge's has too.
  const delivered = new Promise<void>((resolve) =>
    window.addEventListener("message", () => resolve(), { once: true }),
  );
  window.postMessage({ type: "t3-view:ready" }, "*");
  await delivered;
  expect(connections).not.toHaveBeenCalled();
});
