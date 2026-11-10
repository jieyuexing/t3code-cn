import { EnvironmentId, PluginId, ThreadId, type PluginHostSnapshot } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useRightPanelStore } from "../rightPanelStore";
import { usePluginPaletteItems } from "./usePluginPalette";

const fixture = vi.hoisted(() => ({
  snapshot: null as PluginHostSnapshot | null,
  canCall: true,
  result: "" as unknown,
  calls: [] as unknown[],
  toasts: [] as unknown[],
}));

vi.mock("./usePluginHost", () => ({
  usePluginHostSnapshot: () => ({ snapshot: fixture.snapshot, failed: false }),
  useCanCallPluginHost: () => fixture.canCall,
  pluginHostFailureMessage: () => "failed",
}));
vi.mock("./state", () => ({ pluginHostEnvironment: { call: {} } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: unknown) => {
    fixture.calls.push(request);
    return AsyncResult.success({ value: fixture.result });
  },
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: (toast: unknown) => fixture.toasts.push(toast) },
}));

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const pluginId = PluginId.make("example.echo-clock");

function setup(commands: boolean, result: unknown = "ok") {
  fixture.calls = [];
  fixture.toasts = [];
  fixture.canCall = true;
  fixture.result = result;
  useRightPanelStore.setState({ byThreadKey: {} });
  fixture.snapshot = {
    hostEnabled: true,
    registered: 1,
    plugins: [],
    views: commands
      ? [
          {
            pluginId,
            pluginName: "Echo Clock",
            generation: 1,
            viewId: "clock",
            title: "Echo Clock",
            placement: "side-panel",
          },
        ]
      : [],
    commands: commands
      ? [{ pluginId, pluginName: "Echo Clock", commandId: "echo-now", title: "Echo the time" }]
      : [],
    services: [],
  };
}

function Probe() {
  const { settingsItem, groups } = usePluginPaletteItems({ environmentId, id: threadId }, null);
  return (
    <div>
      <button type="button" onClick={() => void settingsItem.run()}>
        {settingsItem.title}
      </button>
      {groups.map((group) => (
        <section key={group.value} aria-label={group.label}>
          {group.items.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => void (item.kind === "action" ? item.run() : undefined)}
            >
              {item.title} · {item.kind === "action" ? item.timestamp : ""}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

it("lists plugin commands and views in their own group, runs a command with its prefix and toasts a string result as is", async () => {
  setup(true, "It is 12:00");
  await using screen = await render(<Probe />, { router: "/" });
  const group = screen.getByRole("region", { name: "Plugins" });
  await expect
    .element(group.getByRole("button", { name: "Open Echo Clock · Echo Clock" }))
    .toBeVisible();

  await group.getByRole("button", { name: "Echo the time · Echo Clock" }).click();
  await vi.waitFor(() => expect(fixture.toasts).toHaveLength(1));
  expect(fixture.calls).toEqual([
    {
      environmentId,
      input: { _tag: "invoke", pluginId, handler: "command:echo-now", input: null },
    },
  ]);
  expect(fixture.toasts[0]).toMatchObject({ title: "Echo the time", description: "It is 12:00" });
});

it("summarizes results that are not text, and the group goes with the plugin", async () => {
  setup(true, { hello: "world" });
  await using screen = await render(<Probe />, { router: "/" });
  await screen
    .getByRole("region", { name: "Plugins" })
    .getByRole("button", { name: "Echo the time · Echo Clock" })
    .click();
  await vi.waitFor(() => expect(fixture.toasts).toHaveLength(1));
  expect(fixture.toasts[0]).toMatchObject({
    title: "Echo the time",
    description: '{"hello":"world"}',
  });

  setup(false);
  await screen.rerender(<Probe />);
  expect(screen.container.querySelector("section")).toBeNull();
  await expect.element(screen.getByRole("button", { name: "Open plugin settings" })).toBeVisible();
});

it("opens a view in the thread's panel and sends settings to the thread's environment", async () => {
  setup(true);
  await using screen = await render(<Probe />, { router: "/" });
  await screen.getByRole("button", { name: "Open Echo Clock · Echo Clock" }).click();
  const state = Object.values(useRightPanelStore.getState().byThreadKey)[0];
  expect(state?.activeSurfaceId).toBe("plugin:example.echo-clock:clock");

  await screen.getByRole("button", { name: "Open plugin settings" }).click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/plugins");
    expect(screen.router?.state.location.search).toEqual({ machine: environmentId });
  });
});

it("offers nothing from plugins without the grant", async () => {
  setup(true);
  fixture.canCall = false;
  await using screen = await render(<Probe />, { router: "/" });
  expect(screen.container.querySelector("section")).toBeNull();
});
