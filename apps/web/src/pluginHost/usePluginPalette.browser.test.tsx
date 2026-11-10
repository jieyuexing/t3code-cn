import {
  EnvironmentId,
  PluginId,
  ThreadId,
  type PluginHostEntry,
  type PluginHostSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useRightPanelStore } from "../rightPanelStore";
import { useServicePanelStore } from "./servicePanelStore";
import { GREET, NOW, providerEntry, servicesSnapshot } from "./testing/snapshots";
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

const SET_TONE: PluginHostEntry["provides"][number]["methods"][number] = {
  name: "setTone",
  title: "Set tone",
  ui: true,
  input: { type: "object", properties: { tone: { type: "string" } }, required: ["tone"] },
};
const clock = providerEntry("example.echo-clock", "Echo Clock", "example.clock", [
  NOW,
  { name: "internal", title: "Internal", readOnly: true },
]);
const greeter = providerEntry("example.greeter", "Greeter", "example.greeter", [GREET, SET_TONE]);

function setup(snapshot: PluginHostSnapshot | null, result: unknown = "ok") {
  fixture.calls = [];
  fixture.toasts = [];
  fixture.canCall = true;
  fixture.result = result;
  useRightPanelStore.setState({ byThreadKey: {} });
  useServicePanelStore.setState({ drafts: {}, focusRequest: null });
  fixture.snapshot = snapshot;
}

const both = () => servicesSnapshot([{ entry: clock }, { entry: greeter }]);

function Probe(props: { readonly thread?: boolean }) {
  const { settingsItem, groups } = usePluginPaletteItems(
    props.thread === false ? null : { environmentId, id: threadId },
    environmentId,
  );
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
              {item.title} {item.titleTrailingContent} ·{" "}
              {item.kind === "action" ? item.timestamp : ""}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

it("lists the ui methods of available services with their service name, and not the other methods", async () => {
  setup(both());
  await using screen = await render(<Probe />, { router: "/" });
  const group = screen.getByRole("region", { name: "Plugins" });
  await expect
    .element(group.getByRole("button", { name: "Current time · example.clock" }))
    .toBeVisible();
  await expect
    .element(group.getByRole("button", { name: "Greet… · example.greeter" }))
    .toBeVisible();
  expect(group.getByRole("button", { name: /Internal/ }).elements()).toHaveLength(0);
  await expect
    .element(group.getByRole("button", { name: "Open example.clock  · Echo Clock" }))
    .toBeVisible();
  await expect
    .element(group.getByRole("button", { name: "Open example.greeter  · Greeter" }))
    .toBeVisible();
});

it("marks methods that change things with Modifies and read-only ones with nothing", async () => {
  setup(both());
  await using screen = await render(<Probe />, { router: "/" });
  await expect
    .element(screen.getByRole("button", { name: "Set tone… Modifies · example.greeter" }))
    .toBeVisible();
  expect(screen.getByRole("button", { name: /Current time.*Modifies/ }).elements()).toHaveLength(0);
});

it("runs a method without required input at once and toasts a string result as is", async () => {
  setup(both(), "It is 12:00");
  await using screen = await render(<Probe />, { router: "/" });
  await screen.getByRole("button", { name: "Current time · example.clock" }).click();
  await vi.waitFor(() => expect(fixture.toasts).toHaveLength(1));
  expect(fixture.calls).toEqual([
    {
      environmentId,
      input: { _tag: "callService", service: "example.clock", method: "now", input: {} },
    },
  ]);
  expect(fixture.toasts[0]).toMatchObject({ title: "Current time", description: "It is 12:00" });
});

it("summarizes results that are not text", async () => {
  setup(both(), { hello: "world" });
  await using screen = await render(<Probe />, { router: "/" });
  await screen.getByRole("button", { name: "Current time · example.clock" }).click();
  await vi.waitFor(() => expect(fixture.toasts).toHaveLength(1));
  expect(fixture.toasts[0]).toMatchObject({
    title: "Current time",
    description: '{"hello":"world"}',
  });
});

it("opens the service panel with the form focused for a method that needs input, without calling", async () => {
  setup(both());
  await using screen = await render(<Probe />, { router: "/" });
  await screen.getByRole("button", { name: "Greet… · example.greeter" }).click();
  expect(fixture.calls).toEqual([]);
  const state = Object.values(useRightPanelStore.getState().byThreadKey)[0];
  expect(state?.activeSurfaceId).toBe("plugin:example.greeter:service:example.greeter");
  expect(state?.surfaces[0]).toMatchObject({
    kind: "plugin",
    pluginId: "example.greeter",
    viewId: "service:example.greeter",
    title: "example.greeter",
  });
  expect(useServicePanelStore.getState().focusRequest).toBe(
    `${environmentId}|example.greeter|greet`,
  );
});

it("lists only methods without required input when no thread is open", async () => {
  setup(both());
  await using screen = await render(<Probe thread={false} />, { router: "/" });
  await expect
    .element(screen.getByRole("button", { name: "Current time · example.clock" }))
    .toBeVisible();
  expect(screen.getByRole("button", { name: /Greet/ }).elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: /Open example\./ }).elements()).toHaveLength(0);
});

it("drops a service's entries when the snapshot no longer lists it as available, though its plugin still declares it", async () => {
  setup(both());
  await using screen = await render(<Probe />, { router: "/" });
  await expect
    .element(screen.getByRole("button", { name: "Current time · example.clock" }))
    .toBeVisible();

  // Disabled: the plugin stays in `plugins` with its declaration, the service leaves `services`.
  setup(servicesSnapshot([{ entry: clock }, { entry: greeter }], false));
  await screen.rerender(<Probe />);
  expect(screen.container.querySelector("section")).toBeNull();

  // Listed but not available (the provider is quarantined, or waits for its own services).
  setup(servicesSnapshot([{ entry: clock }, { entry: greeter, available: false }]));
  await screen.rerender(<Probe />);
  expect(screen.getByRole("button", { name: /Greet/ }).elements()).toHaveLength(0);
  await expect
    .element(screen.getByRole("button", { name: "Current time · example.clock" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open plugin settings" })).toBeVisible();
});

it("opens a view in the thread's panel and sends settings to the thread's environment", async () => {
  const snapshot = both();
  setup({
    ...snapshot,
    views: [
      {
        pluginId,
        pluginName: "Echo Clock",
        generation: 1,
        viewId: "clock",
        title: "Echo Clock",
        placement: "side-panel",
      },
    ],
  });
  await using screen = await render(<Probe />, { router: "/" });
  // Methods first, then the service panels, then the plugins' own views.
  expect(
    [...screen.container.querySelectorAll("section button")].map((button) => button.textContent),
  ).toEqual([
    "Current time  · example.clock",
    "Greet…  · example.greeter",
    "Set tone… Modifies · example.greeter",
    "Open example.clock  · Echo Clock",
    "Open example.greeter  · Greeter",
    "Open Echo Clock  · Echo Clock",
  ]);
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
  setup(both());
  fixture.canCall = false;
  await using screen = await render(<Probe />, { router: "/" });
  expect(screen.container.querySelector("section")).toBeNull();
});
