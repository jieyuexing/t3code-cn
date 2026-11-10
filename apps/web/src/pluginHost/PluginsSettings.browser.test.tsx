import { PluginId, type PluginHostEntry, type PluginHostSnapshot } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { PluginsSettings } from "./PluginsSettings";

const fixture = vi.hoisted(() => ({
  snapshot: null as PluginHostSnapshot | null,
  canCall: true,
  actions: [] as unknown[],
  confirm: true,
}));

vi.mock("./usePluginHost", () => ({
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
  capabilities: ["views", "commands"],
  generation: 1,
  ignoredFields: [],
  rejectedViews: [],
  settings: [],
  settingValues: {},
  ...overrides,
});

function setup(options: { hostEnabled?: boolean; canCall?: boolean } = {}) {
  fixture.actions = [];
  fixture.confirm = true;
  fixture.canCall = options.canCall ?? true;
  fixture.snapshot = {
    hostEnabled: options.hostEnabled ?? true,
    registered: 7,
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
    commands: [],
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
  expect(badgeText("approval-plugin")).toBe("Awaiting consent");
  expect(badgeText("rejected-plugin")).toBe("Not enabled");
  await expect.element(screen.getByText("exited with code 1", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("Retrying at", { exact: false })).toBeVisible();
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
  await expect.element(screen.getByText("7 registered")).toBeVisible();
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
