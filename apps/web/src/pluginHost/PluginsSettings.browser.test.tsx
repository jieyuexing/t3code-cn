import { PluginId, type PluginHostEntry, type PluginHostSnapshot } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { PluginsSettings } from "./PluginsSettings";
import {
  pluginSettingsKey,
  requestPluginSettings,
  usePluginSettingsStore,
} from "./pluginSettingsStore";

const fixture = vi.hoisted(() => ({
  snapshot: null as PluginHostSnapshot | null,
  canCall: true,
  actions: [] as unknown[],
  confirm: true,
  /** What the host answers a `setSetting` with; null accepts it. */
  rejection: null as string | null,
}));

vi.mock("./usePluginHost", () => ({
  pluginHostFailureMessage: () => fixture.rejection ?? "",
  usePluginHostCall: () => async (input: unknown) => {
    fixture.actions.push(input);
    return fixture.rejection === null
      ? AsyncResult.success({ value: null })
      : ({ _tag: "Failure" } as const);
  },
  usePluginHostSnapshot: () => ({ snapshot: fixture.snapshot, failed: false }),
  useCanCallPluginHost: () => fixture.canCall,
  usePluginHostAction: () => async (input: unknown) => {
    fixture.actions.push(input);
    return AsyncResult.success({ value: null });
  },
}));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: { environmentId: "environment-a" } }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../components/settings/SettingsScopeSentence", () => ({
  SettingsScopeSentence: () => null,
}));
vi.mock("../confirmDialog", () => ({
  requestConfirmDialog: async () => fixture.confirm,
}));

const entry = (
  name: string,
  overrides: Partial<PluginHostEntry> & Pick<PluginHostEntry, "state">,
): PluginHostEntry => ({
  id: PluginId.make(`example.${name}`),
  name,
  version: "0.1.0",
  directory: `/plugins/${name}`,
  enabled: true,
  consent: "granted",
  digest: "3f9a0000c21e0000",
  capabilities: ["views"],
  generation: 1,
  ignoredFields: [],
  rejectedViews: [],
  settings: [],
  settingValues: {},
  provides: [],
  waitingFor: [],
  ...overrides,
});

function setup(
  options: {
    hostEnabled?: boolean;
    canCall?: boolean;
    /** Plugins with settings, listed after the others. */
    extra?: ReadonlyArray<PluginHostEntry>;
  } = {},
) {
  fixture.actions = [];
  fixture.confirm = true;
  fixture.rejection = null;
  usePluginSettingsStore.setState({ opened: {}, reveal: null });
  fixture.canCall = options.canCall ?? true;
  fixture.snapshot = {
    hostEnabled: options.hostEnabled ?? true,
    registered: 9,
    plugins: [
      entry("standby-plugin", { state: { _tag: "standby" } }),
      entry("running-plugin", { state: { _tag: "running" }, pid: 48213 }),
      entry("quarantined-plugin", {
        state: { _tag: "quarantined", failures: 3, reason: "exited with code 1" },
      }),
      entry("backoff-plugin", {
        state: {
          _tag: "backoff",
          failures: 1,
          reason: "crashed",
          retryAt: "2026-11-10T13:00:00.000Z",
        },
      }),
      entry("waiting-plugin", {
        state: { _tag: "waiting", reason: "waiting for example.clock" },
        waitingFor: ["example.clock"],
      }),
      entry("cycle-plugin", {
        state: { _tag: "waiting", reason: "dependency cycle: a → b → a" },
        waitingFor: ["example.b"],
      }),
      entry("approval-plugin", { enabled: false, consent: "required", state: { _tag: "idle" } }),
      // The manifest changed after it was enabled: still enabled, but the consent no longer holds.
      entry("changed-plugin", { enabled: true, consent: "required", state: { _tag: "idle" } }),
      entry("rejected-plugin", {
        enabled: false,
        consent: "required",
        state: { _tag: "idle" },
        problem: "The entry ../x.js leaves the plugin folder.",
        rejectedViews: [{ viewId: "main", reason: "the page is missing" }],
      }),
    ],
    views: [],
    services: [],
  };
  fixture.snapshot = {
    ...fixture.snapshot,
    plugins: [...fixture.snapshot.plugins, ...(options.extra ?? [])],
  };
}

const settings = <PluginsSettings />;

it("shows each state in its own word, with reasons for what was rejected or stopped", async () => {
  setup();
  await using screen = await render(settings, { router: "/" });
  const rows = screen.container.querySelectorAll("[data-slot=settings-row]");
  const badgeText = (name: string) =>
    [...rows]
      .find((row) => row.textContent?.includes(`example.${name}`))
      ?.querySelector("[data-slot=badge]")?.textContent;
  await expect.element(screen.getByText("example.standby-plugin", { exact: false })).toBeVisible();
  expect(badgeText("standby-plugin")).toBe("Standby");
  expect(badgeText("running-plugin")).toBe("Running");
  expect(badgeText("quarantined-plugin")).toBe("Quarantined");
  expect(badgeText("backoff-plugin")).toBe("Quarantined");
  expect(badgeText("waiting-plugin")).toBe("Waiting for services");
  expect(badgeText("approval-plugin")).toBe("Awaiting consent");
  expect(badgeText("rejected-plugin")).toBe("Not enabled");
  await expect.element(screen.getByText("exited with code 1", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("Retrying at", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("Waiting for example.clock")).toBeVisible();
  await expect.element(screen.getByText("dependency cycle: a → b → a")).toBeVisible();
  await expect
    .element(screen.getByText("leaves the plugin folder", { exact: false }))
    .toBeVisible();
  await expect.element(screen.getByText("the page is missing", { exact: false })).toBeVisible();
});

it("asks for consent inside the list before enabling a plugin, and retries a quarantined one", async () => {
  setup();
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("switch", { name: "Enable approval-plugin" }).click();
  await expect.element(screen.getByText("Allow approval-plugin to run?")).toBeVisible();
  expect(fixture.actions).toEqual([]);

  await screen.getByRole("button", { name: "Allow and enable" }).click();
  await vi.waitFor(() =>
    expect(fixture.actions).toEqual([
      { _tag: "enable", pluginId: "example.approval-plugin", grantConsent: true },
    ]),
  );

  await screen.getByRole("button", { name: "Retry" }).first().click();
  await vi.waitFor(() =>
    expect(fixture.actions.at(-1)).toEqual({
      _tag: "resume",
      pluginId: "example.quarantined-plugin",
    }),
  );
});

it("asks for consent again when the manifest changed under an enabled plugin", async () => {
  setup();
  await using screen = await render(settings, { router: "/" });
  const toggle = screen.getByRole("switch", { name: "Enable changed-plugin" });
  await expect.element(toggle).not.toBeChecked();
  await toggle.click();
  await expect.element(screen.getByText("Allow changed-plugin to run?")).toBeVisible();
  expect(fixture.actions).toEqual([]);
});

it("adds a folder when Enter is pressed in the path field", async () => {
  setup();
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Add local folder…" }).click();
  await screen.getByRole("textbox", { name: "Plugin folder path" }).fill("/plugins/typed");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(fixture.actions).toEqual([{ _tag: "add", path: "/plugins/typed" }]),
  );
});

it("adds a folder by path and removes a plugin after confirmation", async () => {
  setup();
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Add local folder…" }).click();
  await screen.getByRole("textbox", { name: "Plugin folder path" }).fill("/plugins/new");
  await screen.getByRole("button", { name: "Add", exact: true }).click();
  await vi.waitFor(() => expect(fixture.actions).toEqual([{ _tag: "add", path: "/plugins/new" }]));

  await screen.getByRole("button", { name: "Remove" }).first().click();
  await vi.waitFor(() =>
    expect(fixture.actions.at(-1)).toEqual({ _tag: "remove", pluginId: "example.standby-plugin" }),
  );
});

it("shows only the switch and the registered count while plugins are off", async () => {
  setup({ hostEnabled: false });
  await using screen = await render(settings, { router: "/" });
  await expect.element(screen.getByText("9 registered")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-slot=settings-row]")).toHaveLength(1);
  await screen.getByRole("switch", { name: "Enable plugins" }).click();
  await vi.waitFor(() =>
    expect(fixture.actions).toEqual([{ _tag: "setHostEnabled", enabled: true }]),
  );
});

it("leaves every action disabled for a connection without the grant", async () => {
  setup({ canCall: false });
  await using screen = await render(settings, { router: "/" });
  await expect
    .element(screen.getByRole("switch", { name: "Enable plugins" }))
    .toHaveAttribute("aria-disabled", "true");
  for (const button of screen.container.querySelectorAll("button")) {
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
  }
});

const configurable = (overrides: Partial<PluginHostEntry> = {}) =>
  entry("tortoise", {
    state: { _tag: "standby" },
    settings: [
      { type: "text", key: "cvsPath", label: "cvs executable", default: "cvs" },
      { type: "boolean", key: "showUntracked", label: "Show untracked", default: true },
      { type: "number", key: "pageSize", label: "Page size", default: 200 },
    ],
    settingValues: { cvsPath: "/opt/homebrew/bin/cvs", showUntracked: true, pageSize: 200 },
    ...overrides,
  });

const settingCall = (key: string, value: string | number | boolean) => ({
  _tag: "setSetting",
  pluginId: "example.tortoise",
  key,
  value,
});

it("offers Settings only on a plugin that declares settings, and counts them in its status line", async () => {
  setup({ extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await expect.element(screen.getByText("3 settings", { exact: false })).toBeVisible();
  expect(screen.getByRole("button", { name: "Settings", exact: true }).elements()).toHaveLength(1);
  await expect
    .element(screen.getByRole("textbox", { name: "cvs executable" }))
    .not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "cvs executable" }))
    .toHaveValue("/opt/homebrew/bin/cvs");
  await screen.getByRole("button", { name: "Collapse" }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "cvs executable" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "cvs executable" }))
    .not.toBeInTheDocument();
});

it("saves a text field on Enter and on blur, and shows Saved; an unchanged field saves nothing", async () => {
  setup({ extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  const field = screen.getByRole("textbox", { name: "cvs executable" });

  await field.click();
  await userEvent.keyboard("{Enter}");
  await userEvent.tab();
  expect(fixture.actions).toEqual([]);

  await field.fill("/usr/local/bin/cvs");
  await expect.element(screen.getByText("Unsaved")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(fixture.actions).toEqual([settingCall("cvsPath", "/usr/local/bin/cvs")]),
  );
  await expect.element(screen.getByText("Saved")).toBeVisible();

  await field.fill("/opt/cvs");
  await userEvent.tab();
  await vi.waitFor(() =>
    expect(fixture.actions.at(-1)).toEqual(settingCall("cvsPath", "/opt/cvs")),
  );
});

it("saves a boolean as soon as it is switched", async () => {
  setup({ extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await screen.getByRole("switch", { name: "Show untracked" }).click();
  await vi.waitFor(() => expect(fixture.actions).toEqual([settingCall("showUntracked", false)]));
});

it("keeps a number that is not a finite number from being saved, and saves one that is", async () => {
  setup({ extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  const field = screen.getByRole("textbox", { name: "Page size" });
  for (const bad of ["2O0", "", "Infinity"]) {
    await field.fill(bad);
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("Enter a number")).toBeVisible();
    await expect.element(field).toHaveValue(bad);
  }
  expect(fixture.actions).toEqual([]);

  await field.fill("50");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(fixture.actions).toEqual([settingCall("pageSize", 50)]));
  await expect.element(screen.getByText("Enter a number")).not.toBeInTheDocument();
});

it("offers Reset to default only when the value differs, and writes the default back", async () => {
  setup({
    extra: [
      configurable({
        settingValues: { cvsPath: "/opt/homebrew/bin/cvs", showUntracked: true, pageSize: 200 },
      }),
    ],
  });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  // Page size and the switch stand on their defaults and say so; only the path differs.
  expect(screen.getByText("Default", { exact: true }).elements()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Reset to default (cvs)" }).elements()).toHaveLength(1);
  expect(screen.getByRole("button", { name: /^Reset to default/ }).elements()).toHaveLength(1);
  await screen.getByRole("button", { name: "Reset to default (cvs)" }).click();
  await vi.waitFor(() => expect(fixture.actions).toEqual([settingCall("cvsPath", "cvs")]));
});

it("shows the host's refusal under the field and keeps what was typed", async () => {
  setup({ extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  fixture.rejection = "cvsPath must be a text.";
  const field = screen.getByRole("textbox", { name: "cvs executable" });
  await field.fill("x".repeat(30));
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("cvsPath must be a text.")).toBeVisible();
  await expect.element(field).toHaveValue("x".repeat(30));
  await expect.element(screen.getByText("Saved")).not.toBeInTheDocument();
});

it("is read-only without the grant", async () => {
  setup({ canCall: false, extra: [configurable()] });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.element(screen.getByRole("textbox", { name: "cvs executable" })).toBeDisabled();
  await expect.element(screen.getByRole("textbox", { name: "Page size" })).toBeDisabled();
  await expect
    .element(screen.getByRole("switch", { name: "Show untracked" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect
    .element(screen.getByRole("button", { name: "Reset to default (cvs)" }))
    .toBeDisabled();
});

it("lets a stopped or disabled plugin open its settings and save", async () => {
  setup({
    extra: [
      configurable({
        enabled: false,
        state: { _tag: "quarantined", failures: 3, reason: "cvs not found" },
      }),
    ],
  });
  await using screen = await render(settings, { router: "/" });
  await screen.getByRole("button", { name: "Settings", exact: true }).click();
  await screen.getByRole("textbox", { name: "cvs executable" }).fill("/opt/cvs");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(fixture.actions).toEqual([settingCall("cvsPath", "/opt/cvs")]));
});

it("opens the settings of the plugin a view asked for, scrolls to it, and takes the request", async () => {
  setup({ extra: [configurable()] });
  const scrolled: Element[] = [];
  using _scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    scrolled.push(this);
  });
  requestPluginSettings(
    pluginSettingsKey("environment-a" as never, PluginId.make("example.tortoise")),
  );
  await using screen = await render(settings, { router: "/" });
  await expect.element(screen.getByRole("textbox", { name: "cvs executable" })).toBeVisible();
  await vi.waitFor(() => expect(scrolled).toHaveLength(1));
  expect(scrolled[0]?.textContent).toContain("example.tortoise");
  expect(usePluginSettingsStore.getState().reveal).toBeNull();
});

it("ignores a request made for another environment", async () => {
  setup({ extra: [configurable()] });
  requestPluginSettings(
    pluginSettingsKey("environment-b" as never, PluginId.make("example.tortoise")),
  );
  await using screen = await render(settings, { router: "/" });
  await expect.element(screen.getByText("3 settings", { exact: false })).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "cvs executable" }))
    .not.toBeInTheDocument();
});
