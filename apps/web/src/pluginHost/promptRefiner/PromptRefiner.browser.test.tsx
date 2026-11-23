import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import type { PromptRefineOutcome } from "./promptRefinerClient";

const client = vi.hoisted(() => ({ requestPromptRefine: vi.fn() }));
vi.mock("./promptRefinerClient", () => ({ requestPromptRefine: client.requestPromptRefine }));

// The socket is the only fake layer, so a send lands in `dispatchedCommands` and goes nowhere else.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const refined = (text: string, usedWorkspaceContext = true): PromptRefineOutcome => ({
  ok: true,
  result: { refined: text, mode: "structured", usedWorkspaceContext },
});

/** An open thread whose refiner client answers with `outcomes` in turn, the last one repeating. */
async function openThread(name: string, ...outcomes: ReadonlyArray<PromptRefineOutcome>) {
  client.requestPromptRefine.mockReset();
  for (const outcome of outcomes) client.requestPromptRefine.mockResolvedValueOnce(outcome);
  client.requestPromptRefine.mockResolvedValue(outcomes.at(-1));
  const thread = threadWithHistory(name, 1);
  const environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  return {
    editor,
    threadId: thread.id,
    trigger: page.getByRole("button", { name: /优化提示词/ }),
    card: page.getByRole("region", { name: "提示词优化" }),
    sent: () => dispatchedCommands().filter((command) => command.type === "message.dispatch"),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

it("触发按钮在草稿为空时不可点，有字后点它给出预览，应用替换后可一键撤销，全程不发送", async () => {
  await using view = await openThread(
    "refine-apply",
    refined("先核对仓库顶层结构，再逐条给出设想。"),
  );
  await expect.element(view.trigger).toBeDisabled();
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await expect.element(view.trigger).toBeEnabled();
  await view.trigger.click();
  await expect
    .element(view.card.getByTestId("prompt-refiner-result"))
    .toHaveTextContent("先核对仓库顶层结构，再逐条给出设想。");
  await expect.element(view.card.getByText("已附带仓库上下文")).toBeVisible();
  expect(client.requestPromptRefine).toHaveBeenCalledWith(
    ENVIRONMENT_ID,
    expect.objectContaining({ draft: "看一下架构", mode: "structured", threadId: view.threadId }),
    expect.any(AbortSignal),
  );
  await expect.element(view.editor).toHaveTextContent("看一下架构");

  await view.card.getByRole("button", { name: "应用替换" }).click();
  await expect.element(view.card).not.toBeInTheDocument();
  await expect.element(view.editor).toHaveTextContent("先核对仓库顶层结构，再逐条给出设想。");

  await page.getByRole("button", { name: "撤销优化" }).click();
  await expect.element(view.editor).toHaveTextContent("看一下架构");
  await expect.element(page.getByRole("button", { name: "撤销优化" })).not.toBeInTheDocument();
  expect(view.sent()).toHaveLength(0);
});

it("切换模式用最初的草稿重新优化，并标出当前模式", async () => {
  await using view = await openThread("refine-mode", refined("结构稿"), refined("大胆稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("结构稿");
  await expect
    .element(view.card.getByRole("button", { name: "结构清晰" }))
    .toHaveAttribute("aria-pressed", "true");
  await view.card.getByRole("button", { name: "大胆发散" }).click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("大胆稿");
  expect(client.requestPromptRefine).toHaveBeenLastCalledWith(
    ENVIRONMENT_ID,
    expect.objectContaining({ draft: "看一下架构", mode: "bold" }),
    expect.any(AbortSignal),
  );
  await expect
    .element(view.card.getByRole("button", { name: "大胆发散" }))
    .toHaveAttribute("aria-pressed", "true");
});

it("选中一段时只替换选区，前后文原样保留", async () => {
  await using view = await openThread("refine-selection", refined("替换"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("前文看架构后文");
  await userEvent.keyboard(
    "{Home}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}",
  );
  await view.trigger.click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("替换");
  expect(client.requestPromptRefine).toHaveBeenCalledWith(
    ENVIRONMENT_ID,
    expect.objectContaining({ draft: "前文看架构后文", selection: { start: 2, end: 5 } }),
    expect.any(AbortSignal),
  );
  await view.card.getByRole("button", { name: "应用替换" }).click();
  await expect.element(view.editor).toHaveTextContent("前文替换后文");
});

it("快捷键在输入框里触发优化", async () => {
  await using view = await openThread("refine-shortcut", refined("优化稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  // A chord through userEvent hangs the provider, so the key reaches the focused editor as an event.
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "y",
      shiftKey: true,
      metaKey: isMacPlatform(navigator.platform),
      ctrlKey: !isMacPlatform(navigator.platform),
      bubbles: true,
      cancelable: true,
    }),
  );
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("优化稿");
});

it("Esc 只收起预览卡，草稿保持原样", async () => {
  await using view = await openThread("refine-esc", refined("优化稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect.element(view.card).toBeVisible();
  await userEvent.click(view.editor);
  await userEvent.keyboard("{Escape}");
  await expect.element(view.card).not.toBeInTheDocument();
  await expect.element(view.editor).toHaveTextContent("看一下架构");
});

it("失败时显示原因，点重试再请求一次", async () => {
  await using view = await openThread(
    "refine-error",
    { ok: false, message: "优化超时或失败了，请重试。" },
    refined("重试后的稿"),
  );
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect
    .element(view.card.getByRole("alert"))
    .toHaveTextContent("优化超时或失败了，请重试。");
  await view.card.getByRole("button", { name: "重试" }).click();
  await expect
    .element(view.card.getByTestId("prompt-refiner-result"))
    .toHaveTextContent("重试后的稿");
  expect(client.requestPromptRefine).toHaveBeenCalledTimes(2);
});

it("预览期间草稿被改动时提示，仍可确认替换当前草稿", async () => {
  await using view = await openThread("refine-stale", refined("优化稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toBeVisible();
  await userEvent.click(view.editor);
  await userEvent.keyboard("，再加一句");
  await expect.element(view.card.getByText("草稿已改动")).toBeVisible();
  await view.card.getByRole("button", { name: "应用替换" }).click();
  await expect.element(view.editor).toHaveTextContent("优化稿");
  await page.getByRole("button", { name: "撤销优化" }).click();
  await expect.element(view.editor).toHaveTextContent("看一下架构，再加一句");
});
