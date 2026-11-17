import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ChatCanvasContext } from "~/components/chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "~/components/chat/chatCanvasLayout";
import { ThreadDetailsCard } from "~/components/chat/ThreadDetailsCard";
import { PopoverCreateHandle } from "~/components/ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import "~/index.css";
import { render } from "../../../test/render";
import type { NeedsYouEntry } from "../needsYou/needsYou.logic";
import { AppRail } from "./AppRail";

vi.mock("../usePluginHost", () => ({
  usePluginHostSnapshot: () => ({ snapshot: null, failed: false }),
  useCanCallPluginHost: () => false,
  usePluginHostAction: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../threadPlan/useThreadPlan", () => ({ useThreadPlanProgress: () => null }));
vi.mock("../needsYou/useNeedsYou", () => ({ useNeedsYou: () => needsYou.entries }));
vi.mock("../needsYou/useNeedsYouActions", () => ({ useNeedsYouActions: () => ({}) }));

const needsYou = vi.hoisted(() => ({ entries: [] as ReadonlyArray<NeedsYouEntry> }));

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
const container = { width: 600, height: 800 };

const popoverOpen = () =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    threadRef,
    "popover",
  );

function Harness({
  anchor,
  handle,
  height = 800,
  builtins = {},
}: {
  anchor: HTMLElement;
  handle: PopoverHandle;
  height?: number;
  builtins?: ComponentProps<typeof AppRail>["builtins"];
}) {
  const open = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: () => {},
        measureDetailsCard: () => {},
        detailsCardTopInset: 0,
        preferredDetailsCard: null,
        detailsCardPlacement: null,
      }}
    >
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={{ current: anchor }}
        handle={handle}
        contentKey="1"
      >
        {() => <p>Details body</p>}
      </ThreadDetailsCard>
      <div className="flex" style={{ height }}>
        <AppRail
          threadRef={threadRef}
          controls={{
            terminalAvailable: false,
            terminalOpen: false,
            terminalShortcutLabel: null,
            threadPanelOpen: open,
            threadPanelPresentation: "popover",
            threadPanelPopoverHandle: handle,
            threadPanelShortcutLabel: null,
            rightPanelAvailable: false,
            rightPanelOpen: false,
            rightPanelShortcutLabel: null,
            onToggleTerminal: () => {},
            onToggleThreadPanel: () =>
              useRightPanelStore.getState().toggleThreadPanel(threadRef, "popover"),
            onToggleRightPanel: () => {},
          }}
          onActivate={() => {}}
          onCollapse={() => {}}
          builtins={builtins}
        />
      </div>
    </ChatCanvasContext>
  );
}

type PopoverHandle = ReturnType<typeof PopoverCreateHandle>;

it("opens and closes the details popover from the rail with one click each", async () => {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  using _anchor = { [Symbol.dispose]: () => anchor.remove() };
  await using _screen = await render(<Harness anchor={anchor} handle={PopoverCreateHandle()} />);
  const details = page.getByRole("button", { name: "Thread details" });

  await userEvent.click(details);
  await expect.element(page.getByText("Details body")).toBeVisible();
  expect(popoverOpen()).toBe(true);

  await userEvent.click(details);
  await expect.element(page.getByText("Details body")).not.toBeInTheDocument();
  expect(popoverOpen()).toBe(false);

  await userEvent.click(details);
  await expect.element(page.getByText("Details body")).toBeVisible();
});

const waiting = (threadId: string): NeedsYouEntry => ({
  kind: "failed",
  text: "失败",
  thread: {
    threadId,
    title: `Thread ${threadId}`,
    status: "failed",
    request: null,
    requestId: null,
    lastTurnCompletedAt: null,
    waitingSince: null,
  },
});

it("opens and closes the needs-you list with one click each, and counts only what waits", async () => {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  needsYou.entries = [];
  const anchor = document.createElement("div");
  document.body.append(anchor);
  using _anchor = { [Symbol.dispose]: () => anchor.remove() };
  await using screen = await render(<Harness anchor={anchor} handle={PopoverCreateHandle()} />);
  const button = page.getByRole("button", { name: "Needs you" });
  await expect.element(button).toBeVisible();
  expect(screen.container.querySelector("[aria-label='Needs you'] span")).toBeNull();

  await userEvent.click(button);
  await expect.element(page.getByText("没有等你定的事")).toBeVisible();
  await userEvent.click(button);
  await expect.element(page.getByText("没有等你定的事")).not.toBeInTheDocument();

  needsYou.entries = [waiting("a"), waiting("b")];
  await screen.rerender(<Harness anchor={anchor} handle={PopoverCreateHandle()} />);
  await expect.element(button).toHaveTextContent("2");
  await userEvent.click(button);
  await expect.element(page.getByText("待你定 · 2")).toBeVisible();
});

it("moves the apps that do not fit into a More apps menu, and shows no menu when all fit", async () => {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  using _anchor = { [Symbol.dispose]: () => anchor.remove() };
  const openDiff = vi.fn();
  const builtins = {
    files: { available: true, open: () => {} },
    diff: { available: true, open: openDiff },
  };
  await using screen = await render(
    <Harness anchor={anchor} handle={PopoverCreateHandle()} height={800} builtins={builtins} />,
  );
  await expect.element(page.getByRole("button", { name: "Diff" })).toBeVisible();
  expect(screen.container.querySelector("[aria-label='More apps']")).toBeNull();

  await screen.rerender(
    <Harness anchor={anchor} handle={PopoverCreateHandle()} height={290} builtins={builtins} />,
  );
  await expect.element(page.getByRole("button", { name: "More apps" })).toBeVisible();
  expect(screen.container.querySelector("[aria-label='Diff']")).toBeNull();
  await expect.element(page.getByRole("button", { name: "Needs you" })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "More apps" }));
  await userEvent.click(page.getByRole("button", { name: "Diff" }));
  expect(openDiff).toHaveBeenCalledOnce();
});
