import { createMemoryHistory } from "@tanstack/react-router";
import { RunId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  assistantItem,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { PROMPT_ADVISOR_PREFIX } from "./promptAdvisorPayload.cn";

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

const LISTED = "两条路：\n\n- **甲（推荐）**：只改检查\n- **乙**：再拦一道\n";
const ONLY_PENDING = "做完了。\n\n## 待你定\n1. 要不要合并？\n";

const advisorPayload = (...items: ReadonlyArray<readonly [string, string, string]>) =>
  `${PROMPT_ADVISOR_PREFIX}${JSON.stringify({
    items: items.map(([kind, label, fill]) => ({ kind, label, fill })),
  })}`;

/** The thread's only reply, ending in `reply`, opened with the next-step suggestions on. */
async function openThread(
  name: string,
  reply: string,
  suggestion?: string,
  options?: { readonly expectStrip: boolean },
) {
  const history = threadWithHistory(name, 1);
  const runId = RunId.make(`${name}-run-0`);
  const thread = {
    ...history,
    items: history.items.map((item) =>
      item.type === "assistant_message"
        ? assistantItem(history.id, runId, item.id, item.ordinal, reply)
        : item,
    ),
  };
  const environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    serverSettings: { promptSuggestionsEnabled: true },
    ...(suggestion === undefined ? {} : { promptSuggestion: { runId, text: suggestion } }),
  });
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
  const strip = page.getByRole("group", { name: "Reply options" });
  if (options?.expectStrip !== false) await expect.element(strip).toBeVisible();
  return {
    strip,
    editor: page.getByTestId("composer-editor"),
    sent: () => dispatchedCommands().filter((command) => command.type === "message.dispatch"),
    [Symbol.asyncDispose]: async () => {
      await app[Symbol.asyncDispose]();
      environment[Symbol.dispose]();
    },
  };
}

it("点「按推荐」直接发出这三个字，输入框保持为空", async () => {
  await using view = await openThread("choices-follow", LISTED);
  await view.strip.getByRole("button", { name: "按推荐", exact: true }).click();
  await vi.waitFor(() => expect(view.sent()).toHaveLength(1));
  expect(JSON.stringify(view.sent()[0])).toContain("按推荐");
  expect(view.editor.element().textContent).toBe("");
});

it("点选项只填入标号，不发送", async () => {
  await using view = await openThread("choices-label", LISTED);
  await view.strip.getByRole("button", { name: /^乙/ }).click();
  await expect.element(view.editor).toHaveTextContent("乙");
  expect(view.sent()).toHaveLength(0);
});

it("Tab 只填入第一个按钮，第一个是「按推荐」时也不发送", async () => {
  await using view = await openThread("choices-tab", ONLY_PENDING);
  await expect.element(view.strip.getByRole("button")).toHaveLength(1);
  await userEvent.click(view.editor);
  await userEvent.keyboard("{Tab}");
  await expect.element(view.editor).toHaveTextContent("按推荐");
  expect(view.sent()).toHaveLength(0);
});

it("普通回复：顾问的建议显示成虚线按钮，点了只填入不发送，编码串不出现在输入框里", async () => {
  await using view = await openThread(
    "choices-advisor-plain",
    "改完了，测试通过。",
    advisorPayload(
      ["challenge", "回归没验证", "你确认过回归测试覆盖了这次改动吗？"],
      ["next", "跑完整测试", "跑一遍完整测试并贴结果"],
    ),
  );
  await expect.element(view.strip.getByRole("button", { name: /反问/ })).toBeVisible();
  await expect.element(view.strip.getByRole("button", { name: /推进/ })).toBeVisible();
  await view.strip.getByRole("button", { name: /回归没验证/ }).click();
  await expect.element(view.editor).toHaveTextContent("你确认过回归测试覆盖了这次改动吗？");
  expect(view.sent()).toHaveLength(0);
  expect(document.body.textContent).not.toContain("t3cn-advisor");
});

it("有规则按钮时顾问只追加一枚，「按推荐」照旧直接发送", async () => {
  await using view = await openThread(
    "choices-advisor-listed",
    LISTED,
    advisorPayload(
      ["next", "验收", "先跑回归"],
      ["challenge", "漏了回滚", "两个方案都没说怎么回滚？"],
    ),
  );
  await expect.element(view.strip.getByRole("button", { name: /盲点/ })).toBeVisible();
  await expect.element(view.strip.getByRole("button", { name: /推进/ })).not.toBeInTheDocument();
  await view.strip.getByRole("button", { name: "按推荐", exact: true }).click();
  await vi.waitFor(() => expect(view.sent()).toHaveLength(1));
  expect(JSON.stringify(view.sent()[0])).toContain("按推荐");
});

it("顾问按钮的内容恰好是「按推荐」也只填入，不发送", async () => {
  await using view = await openThread(
    "choices-advisor-follow",
    "改完了。",
    advisorPayload(["next", "照做", "按推荐"]),
  );
  await view.strip.getByRole("button", { name: /照做/ }).click();
  await expect.element(view.editor).toHaveTextContent("按推荐");
  expect(view.sent()).toHaveLength(0);
});

it("Tab 填入第一枚顾问按钮，不发送", async () => {
  await using view = await openThread(
    "choices-advisor-tab",
    "改完了。",
    advisorPayload(["angle", "收窄", "只改登录页会怎样？"]),
  );
  await userEvent.click(view.editor);
  await userEvent.keyboard("{Tab}");
  await expect.element(view.editor).toHaveTextContent("只改登录页会怎样？");
  expect(view.sent()).toHaveLength(0);
});

it("Esc 收起快捷条后顾问按钮不再回来，编码串也不进占位符", async () => {
  await using view = await openThread(
    "choices-advisor-esc",
    "改完了。",
    advisorPayload(["challenge", "回归没验证", "你确认过回归测试覆盖了这次改动吗？"]),
  );
  await userEvent.click(view.editor);
  await userEvent.keyboard("{Escape}");
  await expect.element(view.strip).not.toBeInTheDocument();
  expect(
    page.getByTestId("composer-editor").element().getAttribute("aria-placeholder"),
  ).not.toContain("t3cn-advisor");
});

it("编码串损坏且回复没有选项时：没有快捷条，也不把原始串当灰字", async () => {
  await using _view = await openThread(
    "choices-advisor-damaged",
    "改完了。",
    `${PROMPT_ADVISOR_PREFIX}{not json`,
    { expectStrip: false },
  );
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(page.getByRole("group", { name: "Reply options" })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("t3cn-advisor");
  expect(
    page.getByTestId("composer-editor").element().getAttribute("aria-placeholder"),
  ).not.toContain("t3cn-advisor");
});

it("普通上游灰字照旧显示，不被当成顾问串", async () => {
  await using _view = await openThread("choices-ghost", "改完了。", "跑一下测试", {
    expectStrip: false,
  });
  await expect
    .element(page.getByTestId("composer-editor"))
    .toHaveAttribute("aria-placeholder", "跑一下测试");
});

it("普通回复有 2 枚以上顾问建议时显示合并按钮，点后填入编号汇总文本且不发送", async () => {
  await using view = await openThread(
    "choices-advisor-merge",
    "改完了，测试通过。",
    advisorPayload(
      ["challenge", "回归没验证", "你确认过回归测试覆盖了这次改动吗？"],
      ["next", "跑完整测试", "跑一遍完整测试并贴结果"],
    ),
  );
  const mergeButton = view.strip.getByRole("button", { name: /全部\s*合并 2 条/ });
  await expect.element(mergeButton).toBeVisible();
  await mergeButton.click();
  await expect
    .element(view.editor)
    .toHaveTextContent(
      "请逐条回应以下几点：你确认过回归测试覆盖了这次改动吗？跑一遍完整测试并贴结果",
    );
  const paragraphs = [...view.editor.element().querySelectorAll("p")].map((p) => p.textContent);
  expect(paragraphs[0]).toBe("请逐条回应以下几点：");
  const items = [...view.editor.element().querySelectorAll("ol li")].map((li) => li.textContent);
  expect(items).toEqual(["你确认过回归测试覆盖了这次改动吗？", "跑一遍完整测试并贴结果"]);
  expect(view.sent()).toHaveLength(0);
});

it("英文顾问建议的合并按钮显示英文标签，点后填入英文编号列表且不发送", async () => {
  await using view = await openThread(
    "choices-advisor-merge-en",
    "Done.",
    advisorPayload(
      ["challenge", "Check min > max", "Should clamp(x, min, max) assert when min > max or NaN?"],
      ["next", "Add math tests", "Add unit tests for negative and zero-length bounds."],
      ["angle", "Reuse in metrics", "Check whether metrics.ts can reuse clamp."],
    ),
  );
  const mergeButton = view.strip.getByRole("button", { name: /All\s*Merge 3/ });
  await expect.element(mergeButton).toBeVisible();
  await mergeButton.click();
  const paragraphs = [...view.editor.element().querySelectorAll("p")].map((p) => p.textContent);
  expect(paragraphs[0]).toBe("Please respond to each point:");
  const items = [...view.editor.element().querySelectorAll("ol li")].map((li) => li.textContent);
  expect(items).toEqual([
    "Should clamp(x, min, max) assert when min > max or NaN?",
    "Add unit tests for negative and zero-length bounds.",
    "Check whether metrics.ts can reuse clamp.",
  ]);
  expect(view.sent()).toHaveLength(0);
});
