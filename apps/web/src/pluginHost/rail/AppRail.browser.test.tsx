import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ChatCanvasContext } from "~/components/chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "~/components/chat/chatCanvasLayout";
import { ThreadDetailsCard } from "~/components/chat/ThreadDetailsCard";
import { PopoverCreateHandle } from "~/components/ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { render } from "../../../test/render";
import { AppRail } from "./AppRail";

vi.mock("../usePluginHost", () => ({
  usePluginHostSnapshot: () => ({ snapshot: null, failed: false }),
  useCanCallPluginHost: () => false,
  usePluginHostAction: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../threadPlan/useThreadPlan", () => ({ useThreadPlanProgress: () => null }));

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

function Harness({ anchor, handle }: { anchor: HTMLElement; handle: PopoverHandle }) {
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
        builtins={{}}
      />
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
