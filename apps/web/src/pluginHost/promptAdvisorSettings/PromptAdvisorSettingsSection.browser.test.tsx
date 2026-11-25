import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import type { PromptAdvisorOutcome } from "./promptAdvisorConfigClient";
import type {
  PromptAdvisorConfig,
  PromptAdvisorPayload,
  PromptAdvisorTestRun,
} from "./promptAdvisorConfig.logic";
import { PromptAdvisorSettingsSection } from "./PromptAdvisorSettingsSection";
import {
  advisorPayload,
  advisorStatus,
  DEFAULT_CONFIG,
  roleStatus,
} from "./promptAdvisorSettings.testing";

const client = vi.hoisted(() => ({
  loadPromptAdvisorConfig: vi.fn(),
  savePromptAdvisorConfig: vi.fn(),
  runPromptAdvisorTest: vi.fn(),
}));
vi.mock("./promptAdvisorConfigClient", () => client);
vi.mock("../../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: { environmentId: "environment-a" } }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../../components/settings/SettingsScopeSentence", () => ({
  SettingsScopeSentence: () => null,
}));

const ENVIRONMENT = "environment-a" as EnvironmentId;
const ok = <T,>(value: T): PromptAdvisorOutcome<T> => ({ ok: true, value });
const fails = (message: string, status?: PromptAdvisorTestRun["status"]) =>
  ({ ok: false, message, status }) satisfies PromptAdvisorOutcome<never>;

/** A server that keeps whatever config it is sent, like the real one. */
function serve(initial: PromptAdvisorPayload = advisorPayload()) {
  let current = initial;
  client.loadPromptAdvisorConfig.mockReset().mockImplementation(async () => ok(current));
  client.savePromptAdvisorConfig
    .mockReset()
    .mockImplementation(async (_environment: EnvironmentId, config: PromptAdvisorConfig) => {
      current = { ...current, config };
      return ok(current);
    });
  client.runPromptAdvisorTest.mockReset();
  return {
    saved: () => client.savePromptAdvisorConfig.mock.calls.map(([, config]) => config),
  };
}

const open = async (screenOptions: { readonly router: string } = { router: "/" }) =>
  render(<PromptAdvisorSettingsSection environmentId={ENVIRONMENT} />, screenOptions);

it("shows each role's live status and whether the refiner shares the warm process", async () => {
  serve(
    advisorPayload({
      status: advisorStatus({
        advisor: roleStatus({
          state: "warm",
          activeModel: "gemini-4-neon",
          activeThinking: "low",
          modelSource: "live",
          uses: 3,
          lastDurationMs: 1_200,
        }),
        refiner: roleStatus({ state: "idle", sharesSlot: true }),
      }),
    }),
  );
  await using screen = await open();
  await expect
    .element(
      screen.getByText(
        "Warm · antigravity · gemini-4-neon / low (measured) · reused 3/20 · last 1.2s",
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText("Shares the context advisor's warm process."))
    .toBeVisible();
  expect(client.loadPromptAdvisorConfig).toHaveBeenCalledTimes(1);
});

it("reports a refiner on its own process and surfaces the last error", async () => {
  serve(
    advisorPayload({
      config: {
        ...DEFAULT_CONFIG,
        refiner: { ...DEFAULT_CONFIG.refiner, followAdvisorRuntime: false },
      },
      status: advisorStatus({
        refiner: roleStatus({ sharesSlot: false, lastError: "Antigravity advisor timed out." }),
      }),
    }),
  );
  await using screen = await open();
  await expect.element(screen.getByText("Runs on its own warm process.")).toBeVisible();
  await expect.element(screen.getByText("Antigravity advisor timed out.")).toBeVisible();
});

it("explains a failed load and tries again on request", async () => {
  client.loadPromptAdvisorConfig
    .mockReset()
    .mockResolvedValueOnce(
      fails("Could not reach the server. Check your connection and try again."),
    )
    .mockResolvedValueOnce(ok(advisorPayload()));
  await using screen = await open();
  await expect
    .element(screen.getByText("Could not reach the server", { exact: false }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByText("Context advisor (every turn)")).toBeVisible();
  expect(client.loadPromptAdvisorConfig).toHaveBeenCalledTimes(2);
});

const unsavedBar = (screen: Awaited<ReturnType<typeof open>>) =>
  screen.getByRole("group", { name: "Unsaved changes" });
const save = (screen: Awaited<ReturnType<typeof open>>) =>
  unsavedBar(screen).getByRole("button", { name: "Save", exact: true });

it("keeps a lens switch as a draft until Save, then sends the whole config once", async () => {
  const server = serve();
  await using screen = await open();
  const debugging = screen.getByRole("switch", {
    name: "Systematic debugging (systematic-debugging)",
  });
  await expect.element(debugging).toBeChecked();
  expect(screen.container.querySelector("[role=group]")).toBeNull();
  await debugging.click();
  await expect.element(debugging).not.toBeChecked();
  await expect.element(unsavedBar(screen)).toBeVisible();
  expect(server.saved()).toHaveLength(0);
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]).toEqual({
    ...DEFAULT_CONFIG,
    advisor: {
      ...DEFAULT_CONFIG.advisor,
      lenses: { grilling: true, debugging: false, blastRadius: true },
    },
  });
  await vi.waitFor(() => expect(screen.container.querySelector("[role=group]")).toBeNull());
  await expect.element(debugging).not.toBeChecked();
});

it("picks the advisor's model from the measured list and saves it", async () => {
  const server = serve();
  await using screen = await open();
  await screen.getByRole("combobox", { name: "Model" }).click();
  await screen.getByRole("option", { name: "gemini-4-carbon" }).click();
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]?.advisor.runtime).toEqual({
    instanceId: null,
    model: "gemini-4-carbon",
    thinking: null,
  });
  expect(server.saved()[0]?.refiner.runtime.model).toBeNull();
});

it("turns the refiner's own model picker on and off with the follow switch, saving all edits together", async () => {
  const server = serve();
  await using screen = await open();
  const follow = screen.getByRole("switch", {
    name: "Follow the context advisor's model settings",
  });
  await expect.element(follow).toBeChecked();
  expect(screen.container.querySelectorAll("[aria-label=Model]")).toHaveLength(1);
  await follow.click();
  await expect
    .element(screen.getByText("Starts its own warm process on demand.", { exact: false }))
    .toBeVisible();
  expect(screen.container.querySelectorAll("[aria-label=Model]")).toHaveLength(2);

  await screen.getByRole("combobox", { name: "Model" }).nth(1).click();
  await screen.getByRole("option", { name: "gemini-4-hydrogen" }).click();
  expect(server.saved()).toHaveLength(0);
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]?.refiner).toMatchObject({
    followAdvisorRuntime: false,
    runtime: { model: "gemini-4-hydrogen" },
  });
  expect(server.saved()[0]?.advisor.runtime.model).toBeNull();

  await follow.click();
  expect(screen.container.querySelectorAll("[aria-label=Model]")).toHaveLength(1);
});

it("keeps extra instructions as a draft, and the bar goes away when they are restored to the saved value", async () => {
  const server = serve();
  await using screen = await open();
  const appendix = screen.getByRole("textbox", { name: "Extra instructions" });
  await appendix.fill("多问迁移风险");
  await screen.getByRole("button", { name: "Show the full prompt in effect" }).first().click();
  await expect.element(unsavedBar(screen)).toBeVisible();
  expect(server.saved()).toHaveLength(0);

  await screen.getByRole("button", { name: "Restore default", exact: true }).first().click();
  await vi.waitFor(() => expect(screen.container.querySelector("[role=group]")).toBeNull());
  expect(server.saved()).toHaveLength(0);

  await appendix.fill("再来一条");
  await screen.getByRole("button", { name: "Show the full prompt in effect" }).first().click();
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]?.advisor.customAppendix).toBe("再来一条");
});

it("shows the full prompt in effect, the built-in text as a hint, the fixed-format note, and saves a replacement", async () => {
  const server = serve();
  await using screen = await open();
  await screen.getByRole("button", { name: "Show the full prompt in effect" }).first().click();
  await expect.element(screen.getByText("ADVISOR PROMPT", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("EXPLICIT PROMPT")).toBeVisible();
  await screen.getByRole("button", { name: "Replace the whole prompt" }).click();
  await expect
    .element(screen.getByText("You do not write any JSON", { exact: false }))
    .toBeVisible();
  const replacement = screen.getByRole("textbox", { name: "Replacement prompt" });
  await expect.element(replacement).toHaveAttribute("placeholder", "BUILT-IN ADVISOR INSTRUCTIONS");
  await replacement.fill("只挑最尖锐的问题");
  await screen.getByRole("textbox", { name: "Extra instructions" }).click();
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]?.advisor.promptOverride).toBe("只挑最尖锐的问题");
});

it("edits a refiner mode's prompt, storing nothing while it equals the built-in one", async () => {
  const server = serve();
  await using screen = await open();
  await screen.getByRole("button", { name: "View and edit this mode's prompt" }).first().click();
  const box = screen.getByRole("textbox", { name: "Prompt for Structured" });
  await expect.element(box).toHaveValue("Mode structured: built-in");
  await box.fill("只把草稿改成三句话。");
  await screen.getByRole("textbox", { name: "Extra instructions" }).click();
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(1));
  expect(server.saved()[0]?.refiner.modeOverrides).toEqual({
    structured: "只把草稿改成三句话。",
    bold: "",
    scoped: "",
  });

  await screen.getByRole("button", { name: "Restore default for Structured" }).click();
  await save(screen).click();
  await vi.waitFor(() => expect(server.saved()).toHaveLength(2));
  expect(server.saved()[1]?.refiner.modeOverrides.structured).toBe("");

  await box.fill("Mode structured: built-in");
  await screen.getByRole("textbox", { name: "Extra instructions" }).click();
  await vi.waitFor(() => expect(screen.container.querySelector("[role=group]")).toBeNull());
  expect(server.saved()).toHaveLength(2);
});

it("keeps the draft and shows the reason when saving fails, and Discard goes back to the saved settings", async () => {
  serve();
  client.savePromptAdvisorConfig
    .mockReset()
    .mockResolvedValue(fails("This session does not have permission to change these settings."));
  await using screen = await open();
  const grilling = screen.getByRole("switch", {
    name: "Decision frontier and subtraction (grilling + keel)",
  });
  await grilling.click();
  await save(screen).click();
  await vi.waitFor(() =>
    expect(screen.getByRole("alert").element().textContent).toContain("does not have permission"),
  );
  await expect.element(grilling).not.toBeChecked();
  await expect.element(save(screen)).toBeEnabled();
  await unsavedBar(screen).getByRole("button", { name: "Discard" }).click();
  await expect.element(grilling).toBeChecked();
  await vi.waitFor(() => expect(screen.container.querySelector("[role=group]")).toBeNull());
});

it("disables every control while a save is in flight", async () => {
  serve();
  let release: (outcome: PromptAdvisorOutcome<PromptAdvisorPayload>) => void = () => {};
  client.savePromptAdvisorConfig.mockReset().mockReturnValue(
    new Promise<PromptAdvisorOutcome<PromptAdvisorPayload>>((resolve) => {
      release = resolve;
    }),
  );
  await using screen = await open();
  await screen.getByRole("switch", { name: "Systematic debugging (systematic-debugging)" }).click();
  await save(screen).click();
  await vi.waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Downstream impact proof (blast-radius)" }).element(),
    ).toHaveAttribute("aria-disabled", "true"),
  );
  await expect.element(screen.getByRole("textbox", { name: "Extra instructions" })).toBeDisabled();
  release(ok(advisorPayload()));
  await expect
    .element(screen.getByRole("switch", { name: "Downstream impact proof (blast-radius)" }))
    .not.toHaveAttribute("aria-disabled", "true");
});

const RAN = {
  resolvedInstanceId: "antigravity",
  activeModel: "gemini-4-neon",
  activeThinking: "low",
};

const advisorRun = (patch: Partial<PromptAdvisorTestRun> = {}): PromptAdvisorTestRun => ({
  role: "advisor",
  durationMs: 1_800,
  draft: false,
  ran: RAN,
  items: [
    { kind: "challenge", label: "断言被改了", fill: "你确认过 401 的根因了吗？" },
    { kind: "next", label: "先复现", fill: "先别改代码，复现并贴出错误。" },
  ],
  dropped: 0,
  status: advisorStatus({
    advisor: roleStatus({
      state: "warm",
      activeModel: "gemini-4-neon",
      activeThinking: "low",
      modelSource: "live",
      uses: 1,
    }),
  }),
  ...patch,
});

const tryAdvisor = (screen: Awaited<ReturnType<typeof open>>) =>
  screen.getByRole("button", { name: "Try sample", exact: true }).first();

it("runs an advisor sample on the saved settings and shows the suggestions, where it ran and the time", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(ok(advisorRun()));
  await using screen = await open();
  await screen.getByRole("combobox", { name: "Sample" }).click();
  await screen.getByRole("option", { name: "Debugging" }).click();
  await tryAdvisor(screen).click();
  await expect.element(screen.getByText("断言被改了")).toBeVisible();
  await expect.element(screen.getByText("先别改代码，复现并贴出错误。")).toBeVisible();
  await expect.element(screen.getByText("Challenge")).toBeVisible();
  const outcome = screen.getByTestId("prompt-advisor-test-advisor").element();
  expect(outcome.textContent).toContain("antigravity · gemini-4-neon / low");
  expect(outcome.textContent).toContain("took 1.8s");
  expect(outcome.textContent).not.toContain("unsaved draft");
  expect(client.runPromptAdvisorTest.mock.calls[0]?.[1]).toEqual({
    role: "advisor",
    scenario: "debugging",
  });
});

it("tries the unsaved draft as it is, stays clickable, and does not save anything", async () => {
  const server = serve();
  client.runPromptAdvisorTest.mockResolvedValue(
    ok(advisorRun({ draft: true, ran: { ...RAN, activeModel: "gemini-4-carbon" } })),
  );
  await using screen = await open();
  await screen.getByRole("combobox", { name: "Model" }).click();
  await screen.getByRole("option", { name: "gemini-4-carbon" }).click();
  await screen.getByRole("switch", { name: "Systematic debugging (systematic-debugging)" }).click();
  await expect
    .element(screen.getByText("Runs once on your unsaved edits", { exact: false }))
    .toBeVisible();
  await expect.element(tryAdvisor(screen)).toBeEnabled();
  await tryAdvisor(screen).click();
  await expect.element(screen.getByText("断言被改了")).toBeVisible();
  const request = client.runPromptAdvisorTest.mock.calls[0]?.[1];
  expect(request).toMatchObject({ role: "advisor", scenario: "vague" });
  expect(request?.config?.advisor.runtime.model).toBe("gemini-4-carbon");
  expect(request?.config?.advisor.lenses.debugging).toBe(false);
  const outcome = screen.getByTestId("prompt-advisor-test-advisor").element();
  expect(outcome.textContent).toContain("Ran on your unsaved draft.");
  expect(outcome.textContent).toContain("gemini-4-carbon");
  expect(server.saved()).toHaveLength(0);
  await expect.element(unsavedBar(screen)).toBeVisible();
});

it("tries the refiner on the unsaved draft too", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(
    ok({
      role: "refiner",
      durationMs: 900,
      draft: true,
      ran: RAN,
      refined: "草稿改写结果",
      status: advisorStatus(),
    } satisfies PromptAdvisorTestRun),
  );
  await using screen = await open();
  await screen.getByRole("switch", { name: "Follow the context advisor's model settings" }).click();
  await screen.getByRole("button", { name: "Try sample draft" }).click();
  await expect.element(screen.getByText("草稿改写结果")).toBeVisible();
  const request = client.runPromptAdvisorTest.mock.calls[0]?.[1];
  expect(request?.config?.refiner.followAdvisorRuntime).toBe(false);
  expect(screen.getByTestId("prompt-advisor-test-refiner").element().textContent).toContain(
    "Ran on your unsaved draft.",
  );
});

it("says so when the advisor honestly found nothing for the sample", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(ok(advisorRun({ items: [], dropped: 0 })));
  await using screen = await open();
  await tryAdvisor(screen).click();
  await expect
    .element(screen.getByText("The advisor found nothing worth saying for this sample."))
    .toBeVisible();
});

it("says the safety rules removed the suggestions instead of showing a silent zero", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(ok(advisorRun({ items: [], dropped: 3 })));
  await using screen = await open();
  await tryAdvisor(screen).click();
  await expect
    .element(
      screen.getByText("The advisor returned 3 suggestions, but all were removed", {
        exact: false,
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText("found nothing worth saying", { exact: false }))
    .not.toBeInTheDocument();
});

it("notes how many entries were removed next to the ones that survived", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(ok(advisorRun({ dropped: 1 })));
  await using screen = await open();
  await tryAdvisor(screen).click();
  await expect
    .element(screen.getByText("1 more suggestion was removed by the app's safety rules."))
    .toBeVisible();
});

it("shows a failed test run's reason, including unreadable output, and refreshes the status bar", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(
    fails(
      "Advisor output was not valid JSON. It began: 我觉得可以先看看",
      advisorStatus({ advisor: roleStatus({ lastError: "Advisor output was not valid JSON." }) }),
    ),
  );
  await using screen = await open();
  await tryAdvisor(screen).click();
  await expect
    .element(screen.getByText("Advisor output was not valid JSON. It began: 我觉得可以先看看"))
    .toBeVisible();
  await expect
    .element(screen.getByText("Advisor output was not valid JSON.", { exact: true }))
    .toBeVisible();
});

it("runs the refiner sample in the chosen mode and shows the rewrite", async () => {
  serve();
  client.runPromptAdvisorTest.mockResolvedValue(
    ok({
      role: "refiner",
      durationMs: 2_500,
      draft: false,
      ran: RAN,
      refined: "请检查登录页的校验、加载态与样式，列出问题并逐项修复。",
      status: advisorStatus({
        refiner: roleStatus({
          state: "warm",
          activeModel: "gemini-4-neon",
          activeThinking: "low",
          modelSource: "live",
          uses: 2,
        }),
      }),
    } satisfies PromptAdvisorTestRun),
  );
  await using screen = await open();
  await screen.getByRole("combobox", { name: "Mode" }).click();
  await screen.getByRole("option", { name: "Scoped" }).click();
  await screen.getByRole("button", { name: "Try sample draft" }).click();
  await expect
    .element(screen.getByText("请检查登录页的校验、加载态与样式，列出问题并逐项修复。"))
    .toBeVisible();
  expect(screen.getByTestId("prompt-advisor-test-refiner").element().textContent).toContain(
    "took 2.5s",
  );
  expect(client.runPromptAdvisorTest.mock.calls[0]?.[1]).toEqual({
    role: "refiner",
    mode: "scoped",
  });
});
