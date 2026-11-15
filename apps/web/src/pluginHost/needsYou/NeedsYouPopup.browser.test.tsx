import { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { PopoverCreateHandle, PopoverTrigger } from "~/components/ui/popover";
import { render } from "../../../test/render";
import { NeedsYouPopup } from "./NeedsYouPopup";
import type { NeedsYouEntry } from "./needsYou.logic";

const mocks = vi.hoisted(() => ({
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    snooze: { id: "snooze" },
    respondToApproval: { id: "respondToApproval" },
    startTurn: { id: "startTurn" },
  },
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => ({ runtimeMode: "full-access" }) },
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: { id: string }) => mocks.commands[command.id],
}));

const environmentId = EnvironmentId.make("environment-a");

function setup() {
  const success = async () => ({ _tag: "Success", value: null });
  mocks.commands = {
    snooze: vi.fn(success),
    respondToApproval: vi.fn(success),
    startTurn: vi.fn(success),
  };
}

const entry = (
  threadId: string,
  kind: NeedsYouEntry["kind"],
  over: Partial<NeedsYouEntry["thread"]> = {},
): NeedsYouEntry => ({
  kind,
  text: `${threadId} 的待决`,
  thread: {
    threadId,
    title: `线程 ${threadId}`,
    status: kind === "approval" ? "approval" : "done",
    request: null,
    requestId: null,
    lastTurnCompletedAt: null,
    waitingSince: "2026-11-11T10:00:00.000Z",
    ...over,
  },
});

function Harness({ entries }: { entries: ReadonlyArray<NeedsYouEntry> }) {
  const [handle] = useState(() => PopoverCreateHandle());
  return (
    <>
      <PopoverTrigger handle={handle} render={<button type="button">打开</button>} />
      <NeedsYouPopup
        handle={handle}
        environmentId={environmentId}
        entries={entries}
        onOpenChange={() => {}}
      />
    </>
  );
}

it("sends 按推荐 or a typed reply to the thread as a new message", async () => {
  setup();
  await using _screen = await render(<Harness entries={[entry("a", "reply")]} />);
  await userEvent.click(page.getByRole("button", { name: "打开" }));
  await expect.element(page.getByText("待你定 · 1")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "按推荐" }));
  expect(mocks.commands.startTurn).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      threadId: "a",
      runtimeMode: "full-access",
      message: expect.objectContaining({ role: "user", text: "按推荐", attachments: [] }),
    }),
  });
  await expect.element(page.getByText("已发送，线程处理中")).toBeVisible();
});

it("sends what is typed on Enter", async () => {
  setup();
  await using _screen = await render(<Harness entries={[entry("a", "reply")]} />);
  await userEvent.click(page.getByRole("button", { name: "打开" }));
  await userEvent.type(page.getByRole("textbox", { name: "自定义回复" }), "先并入周报{Enter}");
  expect(mocks.commands.startTurn).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      message: expect.objectContaining({ text: "先并入周报" }),
    }),
  });
});

it("answers an approval with the open request's id", async () => {
  setup();
  const requestId = RuntimeRequestId.make("request-1");
  await using _screen = await render(<Harness entries={[entry("a", "approval", { requestId })]} />);
  await userEvent.click(page.getByRole("button", { name: "打开" }));
  await userEvent.click(page.getByRole("button", { name: "允许一次" }));
  expect(mocks.commands.respondToApproval).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "a", requestId, decision: "accept" },
  });
  await expect.element(page.getByText("已允许")).toBeVisible();
});

it("declines an approval", async () => {
  setup();
  const requestId = RuntimeRequestId.make("request-2");
  await using _screen = await render(<Harness entries={[entry("b", "approval", { requestId })]} />);
  await userEvent.click(page.getByRole("button", { name: "打开" }));
  await userEvent.click(page.getByRole("button", { name: "拒绝" }));
  expect(mocks.commands.respondToApproval).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "b", requestId, decision: "decline" },
  });
});

it("snoozes a thread and says so when there is nothing waiting", async () => {
  setup();
  await using screen = await render(<Harness entries={[entry("c", "failed")]} />);
  await userEvent.click(page.getByRole("button", { name: "打开" }));
  await userEvent.click(page.getByRole("button", { name: "稍后处理" }));
  expect(mocks.commands.snooze).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "c", snoozedUntil: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
  });
  await screen.rerender(<Harness entries={[]} />);
  await expect.element(page.getByText("没有等你定的事")).toBeVisible();
});
