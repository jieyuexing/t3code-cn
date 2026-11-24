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
  return openThreads([name], ...outcomes);
}

/** The first of `names` is open; `router` moves to the others. */
async function openThreads(
  names: ReadonlyArray<string>,
  ...outcomes: ReadonlyArray<PromptRefineOutcome>
) {
  client.requestPromptRefine.mockReset();
  for (const outcome of outcomes) client.requestPromptRefine.mockResolvedValueOnce(outcome);
  client.requestPromptRefine.mockResolvedValue(outcomes.at(-1));
  const threads = names.map((name) => threadWithHistory(name, 1));
  const thread = threads[0]!;
  const environment = installFakeEnvironment(threads, { acceptCommands: true });
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
    router,
    threads,
    threadId: thread.id,
    trigger: page.getByRole("button", { name: /Refine prompt/ }),
    card: page.getByRole("region", { name: "Prompt Refiner" }),
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
  await expect.element(view.card.getByText("Workspace context attached")).toBeVisible();
  expect(client.requestPromptRefine).toHaveBeenCalledWith(
    ENVIRONMENT_ID,
    expect.objectContaining({ draft: "看一下架构", mode: "structured", threadId: view.threadId }),
    expect.any(AbortSignal),
  );
  await expect.element(view.editor).toHaveTextContent("看一下架构");

  await view.card.getByRole("button", { name: "Apply" }).click();
  await expect.element(view.card).not.toBeInTheDocument();
  await expect.element(view.editor).toHaveTextContent("先核对仓库顶层结构，再逐条给出设想。");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect.element(view.editor).toHaveTextContent("看一下架构");
  await expect.element(page.getByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(view.sent()).toHaveLength(0);
});

it("切换模式用最初的草稿重新优化，并标出当前模式", async () => {
  await using view = await openThread("refine-mode", refined("结构稿"), refined("大胆稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("结构稿");
  await expect
    .element(view.card.getByRole("button", { name: "Structured" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(view.editor);
  await userEvent.keyboard("，又改了几个字");
  await view.card.getByRole("button", { name: "Divergent" }).click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toHaveTextContent("大胆稿");
  expect(client.requestPromptRefine).toHaveBeenLastCalledWith(
    ENVIRONMENT_ID,
    expect.objectContaining({ draft: "看一下架构", mode: "bold" }),
    expect.any(AbortSignal),
  );
  await expect
    .element(view.card.getByRole("button", { name: "Divergent" }))
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
  await view.card.getByRole("button", { name: "Apply" }).click();
  await expect.element(view.editor).toHaveTextContent("前文替换后文");
});

it("快捷键在输入框里触发优化", async () => {
  await using view = await openThread("refine-shortcut", refined("优化稿"));
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  const mod = isMacPlatform(navigator.platform) ? "Meta" : "Control";
  await userEvent.keyboard(`{${mod}>}{Shift>}y{/Shift}{/${mod}}`);
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
    { ok: false, message: "Refinement timed out or failed. Try again." },
    refined("重试后的稿"),
  );
  await userEvent.click(view.editor);
  await userEvent.keyboard("看一下架构");
  await view.trigger.click();
  await expect
    .element(view.card.getByRole("alert"))
    .toHaveTextContent("Refinement timed out or failed. Try again.");
  await view.card.getByRole("button", { name: "Retry" }).click();
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
  await expect.element(view.card.getByText("Draft changed")).toBeVisible();
  await view.card.getByRole("button", { name: "Apply" }).click();
  await expect.element(view.editor).toHaveTextContent("优化稿");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.element(view.editor).toHaveTextContent("看一下架构，再加一句");
});

it("切到另一个线程后预览卡收起，甲线程的优化稿不会进入乙线程的输入框", async () => {
  await using view = await openThreads(
    ["refine-owner-a", "refine-owner-b"],
    refined("甲线程的优化稿"),
  );
  await userEvent.click(view.editor);
  await userEvent.keyboard("甲线程草稿");
  await view.trigger.click();
  await expect.element(view.card.getByTestId("prompt-refiner-result")).toBeVisible();
  await view.router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENVIRONMENT_ID, threadId: view.threads[1]!.id },
  });
  await expect.element(view.card).not.toBeInTheDocument();
  await expect.element(view.editor).not.toHaveTextContent("甲线程的优化稿");
  expect(view.sent()).toHaveLength(0);
});
