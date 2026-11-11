import { EnvironmentId, PluginId, type PluginHostSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import type { RightPanelSurface } from "../rightPanelStore";
import { PluginViewPanel } from "./PluginViewPanel";

const fixture = vi.hoisted(() => ({
  snapshot: null as PluginHostSnapshot | null,
  canCall: true,
}));

vi.mock("./usePluginHost", () => ({
  usePluginHostSnapshot: () => ({ snapshot: fixture.snapshot, failed: false }),
  useCanCallPluginHost: () => fixture.canCall,
}));
vi.mock("./PluginServicePanel", () => ({
  PluginServicePanel: (props: { service: string }) => (
    <div data-testid="service-panel">{`service panel ${props.service}`}</div>
  ),
}));
vi.mock("./PluginViewFrame", () => ({
  PluginViewFrame: (props: { generation: number }) => (
    <div data-testid="frame">{`frame generation ${props.generation}`}</div>
  ),
}));

const environmentId = EnvironmentId.make("environment-a");
const pluginId = PluginId.make("example.echo-clock");
const surface: Extract<RightPanelSurface, { kind: "plugin" }> = {
  id: "plugin:example.echo-clock:clock",
  kind: "plugin",
  pluginId,
  viewId: "clock",
  title: "Echo Clock",
};

function setup(generation: number | null, canCall = true) {
  fixture.canCall = canCall;
  fixture.snapshot = {
    hostEnabled: true,
    registered: 1,
    plugins: [],
    services: [],
    views:
      generation === null
        ? []
        : [
            {
              pluginId,
              pluginName: "Echo Clock",
              generation,
              viewId: "clock",
              title: "Echo Clock",
              placement: "side-panel",
            },
          ],
  };
}

const panel = (visible: boolean, onCloseSurface = vi.fn()) => (
  <PluginViewPanel
    surface={surface}
    environmentId={environmentId}
    visible={visible}
    onCloseSurface={onCloseSurface}
  />
);

it("mounts a fresh page when the plugin comes back under a newer generation", async () => {
  setup(1);
  await using screen = await render(panel(true), { router: "/" });
  await expect.element(screen.getByTestId("frame")).toHaveTextContent("frame generation 1");

  // Disabled: the page goes away.
  setup(null);
  await screen.rerender(panel(true));
  await expect
    .element(screen.getByText('Plugin "Echo Clock" is unavailable', { exact: false }))
    .toBeVisible();
  expect(screen.container.querySelector("[data-testid=frame]")).toBeNull();

  // Re-enabled or reloaded: the tab recovers by itself with the new page.
  setup(2);
  await screen.rerender(panel(true));
  await expect.element(screen.getByTestId("frame")).toHaveTextContent("frame generation 2");
});

it("mounts the page again when the same generation comes back after the view left", async () => {
  setup(1);
  await using screen = await render(panel(true), { router: "/" });
  await expect.element(screen.getByTestId("frame")).toBeVisible();

  setup(null);
  await screen.rerender(panel(true));
  await expect.element(screen.getByText("is unavailable", { exact: false })).toBeVisible();

  setup(1);
  await screen.rerender(panel(true));
  await expect.element(screen.getByTestId("frame")).toHaveTextContent("frame generation 1");
});

it("shows the unavailable state when the view leaves the snapshot, with a way to close or open settings", async () => {
  setup(1);
  const onCloseSurface = vi.fn();
  await using screen = await render(panel(true, onCloseSurface), { router: "/" });
  await expect.element(screen.getByTestId("frame")).toBeVisible();

  setup(null);
  await screen.rerender(panel(true, onCloseSurface));
  await screen.getByRole("button", { name: "Close this tab" }).click();
  expect(onCloseSurface).toHaveBeenCalledWith(surface);

  await screen.getByRole("button", { name: "Open plugin settings" }).click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/plugins");
    expect(screen.router?.state.location.search).toEqual({ machine: environmentId });
  });
});

it("keeps the page out of the document while the tab is hidden and without the grant", async () => {
  setup(1);
  await using screen = await render(panel(false), { router: "/" });
  expect(screen.container.querySelector("[data-testid=frame]")).toBeNull();

  await screen.rerender(panel(true));
  await expect.element(screen.getByTestId("frame")).toBeVisible();

  setup(1, false);
  await screen.rerender(panel(true));
  await expect.element(screen.getByText("cannot use plugin views", { exact: false })).toBeVisible();
  expect(screen.container.querySelector("[data-testid=frame]")).toBeNull();
});

it("draws a service: view id as the host's service panel, not as a plugin page", async () => {
  setup(1);
  const serviceSurface: Extract<RightPanelSurface, { kind: "plugin" }> = {
    ...surface,
    id: "plugin:example.echo-clock:service:example.clock",
    viewId: "service:example.clock",
    title: "example.clock",
  };
  await using screen = await render(
    <PluginViewPanel
      surface={serviceSurface}
      environmentId={environmentId}
      visible
      onCloseSurface={vi.fn()}
    />,
    { router: "/" },
  );
  await expect
    .element(screen.getByTestId("service-panel"))
    .toHaveTextContent("service panel example.clock");
  expect(screen.container.querySelector("[data-testid=frame]")).toBeNull();
});
