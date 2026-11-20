import { EnvironmentId, PluginId, type PluginHostSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import type { PluginSurface } from "../rightPanelStore";
import { PluginServicePanel } from "./PluginServicePanel";
import { methodKey, useServicePanelStore } from "./servicePanelStore";
import { GREET, providerEntry, servicesSnapshot } from "./testing/snapshots";

type Outcome =
  | { readonly _tag: "Success"; readonly value: { readonly value: unknown } }
  | { readonly _tag: "Failure"; readonly message: string };

const fixture = vi.hoisted(() => ({
  snapshot: null as PluginHostSnapshot | null,
  canCall: true,
  calls: [] as unknown[],
  outcome: { _tag: "Success", value: { value: null } } as Outcome,
}));

vi.mock("./usePluginHost", () => ({
  usePluginHostSnapshot: () => ({ snapshot: fixture.snapshot, failed: false }),
  useCanCallPluginHost: () => fixture.canCall,
  usePluginHostCall: () => async (input: unknown) => {
    fixture.calls.push(input);
    return fixture.outcome;
  },
  pluginHostFailureMessage: (result: { message?: string }) => result.message ?? "",
}));

const environmentId = EnvironmentId.make("environment-a");
const service = "example.greeter";
const surface: PluginSurface = {
  kind: "plugin",
  pluginId: PluginId.make("example.greeter"),
  viewId: `service:${service}`,
  title: service,
};

const SET_TONE = {
  name: "setTone",
  title: "Set tone",
  ui: true,
  input: {
    type: "object",
    required: ["tone"],
    properties: { tone: { type: "string", enum: ["friendly", "formal"] } },
  },
} as const;
const greeter = (state: PluginHostSnapshot["plugins"][number]["state"] = { _tag: "standby" }) =>
  providerEntry(
    "example.greeter",
    "Greeter",
    service,
    [GREET, SET_TONE, { name: "hidden", title: "Hidden" }],
    { state },
  );

function setup(available = true, listed = true) {
  fixture.calls = [];
  fixture.canCall = true;
  fixture.outcome = { _tag: "Success", value: { value: null } };
  useServicePanelStore.setState({ drafts: {}, focusRequest: null });
  fixture.snapshot = servicesSnapshot([{ entry: greeter(), available }], listed);
}

const panel = (onCloseSurface = vi.fn()) => (
  <PluginServicePanel
    surface={surface}
    service={service}
    environmentId={environmentId}
    visible
    onCloseSurface={onCloseSurface}
  />
);

const open = async (screen: Awaited<ReturnType<typeof render>>, name: string) => {
  const trigger = screen.getByRole("button", { name: new RegExp(name) });
  await trigger.click();
};

it("lists only the ui methods in declared order, with their provider and whether they modify", async () => {
  setup();
  await using screen = await render(panel(), { router: "/" });
  await expect.element(screen.getByText("Greeter · example.greeter")).toBeVisible();
  const triggers = screen.container.querySelectorAll("[data-slot=collapsible-trigger]");
  expect([...triggers].map((trigger) => trigger.textContent)).toEqual([
    "GreetgreetRead only",
    "Set tonesetToneModifies",
  ]);
});

it("blocks a call with a required field empty, then calls with the typed value and shows the JSON result", async () => {
  setup();
  fixture.outcome = { _tag: "Success", value: { value: { greeting: "Hello, Ada!" } } };
  await using screen = await render(panel(), { router: "/" });
  await open(screen, "Greet");
  await screen.getByRole("button", { name: "Call" }).click();
  await expect.element(screen.getByText("Required")).toBeVisible();
  expect(fixture.calls).toEqual([]);

  await userEvent.type(screen.getByRole("textbox", { name: "name" }), "Ada");
  // The refusal goes away as soon as the field is edited.
  expect(screen.container.textContent).not.toContain("Required");
  await screen.getByRole("button", { name: "Call" }).click();
  await vi.waitFor(() =>
    expect(screen.getByRole("status").element().textContent).toContain('"greeting": "Hello, Ada!"'),
  );
  expect(fixture.calls).toEqual([
    { _tag: "callService", service, method: "greet", input: { name: "Ada" } },
  ]);
});

it("submits with Enter in a single-line field and with Ctrl+Enter, and keeps the focus where it was", async () => {
  setup();
  await using screen = await render(panel(), { router: "/" });
  await open(screen, "Greet");
  const field = screen.getByRole("textbox", { name: "name" });
  await userEvent.type(field, "Ada{Enter}");
  await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(fixture.calls).toHaveLength(2));
  expect(document.activeElement).toBe(field.element());
});

it("shows an error as the host worded it, in the alert role", async () => {
  setup();
  fixture.outcome = {
    _tag: "Failure",
    message:
      "Plugin host: call-failed. example.greeter (example.greeter): Backing off until 23:15:10",
  };
  await using screen = await render(panel(), { router: "/" });
  await open(screen, "Greet");
  await userEvent.type(screen.getByRole("textbox", { name: "name" }), "Ada{Enter}");
  await vi.waitFor(() =>
    expect(screen.getByRole("alert").element().textContent).toContain(
      "example.greeter (example.greeter): Backing off until 23:15:10",
    ),
  );
});

it("stays open when the service goes away, keeps what was typed, cannot call, and recovers by itself", async () => {
  setup();
  const onCloseSurface = vi.fn();
  await using screen = await render(panel(onCloseSurface), { router: "/" });
  await open(screen, "Greet");
  await userEvent.type(screen.getByRole("textbox", { name: "name" }), "Ada");

  // Disabled: the plugin stays in the snapshot with its declaration; its service is no longer listed.
  setup(true, false);
  useServicePanelStore.getState().patch(methodKey(environmentId, service, "greet"), {
    open: true,
    values: { name: "Ada" },
  });
  await screen.rerender(panel(onCloseSurface));
  await expect.element(screen.getByText("is unavailable", { exact: false })).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "name" })).toHaveValue("Ada");
  await expect.element(screen.getByRole("button", { name: "Call" })).toBeDisabled();
  await screen.getByRole("button", { name: "Close this tab" }).click();
  expect(onCloseSurface).toHaveBeenCalledTimes(1);

  setup(true, true);
  useServicePanelStore.getState().patch(methodKey(environmentId, service, "greet"), {
    open: true,
    values: { name: "Ada" },
  });
  await screen.rerender(panel(onCloseSurface));
  expect(screen.container.textContent).not.toContain("is unavailable");
  await expect.element(screen.getByRole("button", { name: "Call" })).toBeEnabled();
});

it("is unavailable while the service is listed but cannot be called", async () => {
  setup(false);
  await using screen = await render(panel(), { router: "/" });
  await expect.element(screen.getByText("is unavailable", { exact: false })).toBeVisible();
  await open(screen, "Greet");
  await expect.element(screen.getByRole("button", { name: "Call" })).toBeDisabled();
});

it("opens and focuses the form a palette entry asked for", async () => {
  setup();
  useServicePanelStore.getState().requestFocus(methodKey(environmentId, service, "greet"));
  await using screen = await render(panel(), { router: "/" });
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "name" }).element()),
  );
  expect(useServicePanelStore.getState().focusRequest).toBeNull();
});

it("draws an enum as a select and sends the chosen option", async () => {
  setup();
  await using screen = await render(panel(), { router: "/" });
  await open(screen, "Set tone");
  await screen.getByRole("combobox", { name: "tone" }).click();
  await screen.getByRole("option", { name: "formal" }).click();
  await screen.getByRole("button", { name: "Call" }).click();
  await vi.waitFor(() => expect(fixture.calls).toHaveLength(1));
  expect(fixture.calls[0]).toMatchObject({ method: "setTone", input: { tone: "formal" } });
});

it("shows a placeholder when the provider is gone or the grant is missing", async () => {
  setup();
  fixture.canCall = false;
  await using screen = await render(panel(), { router: "/" });
  await expect
    .element(screen.getByText("cannot use plugin services", { exact: false }))
    .toBeVisible();
});

it("is unavailable, and says nothing of its methods, while no plugin is listed at all", async () => {
  setup();
  fixture.snapshot = { hostEnabled: false, registered: 2, plugins: [], views: [], services: [] };
  await using screen = await render(panel(), { router: "/" });
  await expect.element(screen.getByText("is unavailable", { exact: false })).toBeVisible();
  expect(screen.container.textContent).not.toContain("offers no methods");
});
