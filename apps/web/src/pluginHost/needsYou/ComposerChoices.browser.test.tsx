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

/** The thread's only reply, ending in `reply`, opened with the next-step suggestions on. */
async function openThread(name: string, reply: string) {
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
  const strip = page.getByRole("group", { name: "回复里的选项" });
  await expect.element(strip).toBeVisible();
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
