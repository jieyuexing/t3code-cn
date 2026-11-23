import { EnvironmentId, RuntimeRequestId, type NeedsYouGtd } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { PopoverCreateHandle, PopoverTrigger } from "~/components/ui/popover";
import { render } from "../../../test/render";
import { NeedsYouPopup } from "./NeedsYouPopup";
import type { NeedsYouEntry } from "./needsYou.logic";

const mocks = vi.hoisted(() => ({
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  hostCall: vi.fn(),
  activate: vi.fn(),
  copy: vi.fn(),
  canOpen: true,
}));

vi.mock("../usePluginHost", () => ({ usePluginHostCall: () => mocks.hostCall }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    capabilities: { canOpenDefault: mocks.canOpen },
    activate: mocks.activate,
  }),
}));
vi.mock("~/hooks/useCopyToClipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useCopyToClipboard")>()),
  writeTextToClipboard: async (text: string) => {
    mocks.copy(text);
    return true;
  },
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

const THREAD_UUID = "2756bac6-cb25-46d8-9777-39732a4d3973";

const digest = (over: Partial<NeedsYouGtd> = {}): NeedsYouGtd => ({
  available: true,
  overdue: [
    {
      file: "host/docs/A.md",
      line: 3,
      date: "2026-11-20",
      daysLeft: -3,
      section: "旧事",
      excerpt: "这件事已经过期",
    },
  ],
  upcoming: [
    {
      file: "host/docs/B.md",
      line: 9,
      date: "2026-11-25",
      daysLeft: 2,
      section: "新事",
      excerpt: "这件事快到期",
    },
  ],
  topics: [
    {
      topic: "待办话题",
      thread: `t3-thread://${THREAD_UUID}`,
      capturedAt: "2026-11-11 18:30",
      status: "pending",
    },
    {
      topic: "纯文字来源话题",
      thread: "某个会话",
      capturedAt: "2026-11-14 22:50",
      status: "started",
    },
  ],
  orphans: [{ date: "2026-11-23", repo: "skills", file: "skills/a.md", subject: "feat: 孤儿提交" }],
  recentLinkedCount: 3,
  privateCount: 9,
  reposScanned: 39,
  errors: [],
  scannedAt: "2026-11-23T00:00:00.000Z",
  ...over,
});

const hostReturns = (value: NeedsYouGtd) =>
  mocks.hostCall.mockResolvedValue({ _tag: "Success", value: { value } });

function setup() {
  mocks.hostCall.mockReset();
  mocks.activate.mockReset();
  mocks.copy.mockReset();
  mocks.canOpen = true;
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

function Harness({ entries, cwd }: { entries: ReadonlyArray<NeedsYouEntry>; cwd?: string | null }) {
  const [handle] = useState(() => PopoverCreateHandle());
  return (
    <>
      <PopoverTrigger handle={handle} render={<button type="button">打开</button>} />
      <NeedsYouPopup
        handle={handle}
        environmentId={environmentId}
        entries={entries}
        cwd={cwd}
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

const trigger = () => page.getByRole("button", { name: "打开", exact: true });
const tab = (name: string) => page.getByRole("tab", { name });

it("asks nothing and shows no tabs without a project directory", async () => {
  setup();
  await using _screen = await render(<Harness entries={[entry("a", "reply")]} />);
  await userEvent.click(trigger());
  await expect.element(page.getByText("待你定 · 1")).toBeVisible();
  expect(page.getByRole("tablist").elements()).toHaveLength(0);
  expect(mocks.hostCall).not.toHaveBeenCalled();
});

it("reads the digest when the popup opens, once a minute at most", async () => {
  setup();
  hostReturns(digest());
  await using _screen = await render(<Harness entries={[]} cwd="/universe/cache" />);
  expect(mocks.hostCall).not.toHaveBeenCalled();

  await userEvent.click(trigger());
  await expect.element(tab("唤醒 (2)")).toBeVisible();
  expect(mocks.hostCall).toHaveBeenCalledTimes(1);
  expect(mocks.hostCall).toHaveBeenCalledWith({
    _tag: "needsYouGtd",
    cwd: "/universe/cache",
    dueDays: 30,
    recentDays: 14,
  });

  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger());
  await expect.element(tab("唤醒 (2)")).toBeVisible();
  expect(mocks.hostCall).toHaveBeenCalledTimes(1);

  await userEvent.click(page.getByRole("button", { name: "刷新" }));
  await vi.waitFor(() => expect(mocks.hostCall).toHaveBeenCalledTimes(2));
});

it("keeps the pending list and hides the tabs when the project has no digest", async () => {
  setup();
  hostReturns(digest({ available: false, overdue: [], upcoming: [], topics: [], orphans: [] }));
  await using _screen = await render(
    <Harness entries={[entry("a", "reply")]} cwd="/universe/plain" />,
  );
  await userEvent.click(trigger());
  await vi.waitFor(() => expect(mocks.hostCall).toHaveBeenCalledTimes(1));
  await expect.element(page.getByText("待你定 · 1")).toBeVisible();
  expect(page.getByRole("tablist").elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "刷新" }).elements()).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "按推荐" }));
  expect(mocks.commands.startTurn).toHaveBeenCalled();
});

it("keeps the plain popup when the digest cannot be read", async () => {
  setup();
  mocks.hostCall.mockResolvedValue({ _tag: "Failure" });
  await using _screen = await render(
    <Harness entries={[entry("a", "reply")]} cwd="/universe/broken" />,
  );
  await userEvent.click(trigger());
  await vi.waitFor(() => expect(mocks.hostCall).toHaveBeenCalledTimes(1));
  await expect.element(page.getByText("待你定 · 1")).toBeVisible();
  expect(page.getByRole("tablist").elements()).toHaveLength(0);
});

it("switches between the pending, wake and inbox tabs", async () => {
  setup();
  hostReturns(digest());
  await using screen = await render(
    <Harness entries={[entry("a", "reply")]} cwd="/universe/tabs" />,
  );
  await userEvent.click(trigger());
  await expect.element(tab("待定 (1)")).toBeVisible();
  await expect.element(tab("收件·孤儿 (3)")).toBeVisible();
  // The pending tab is the unchanged list, and the badge in the title counts only the threads.
  await expect.element(page.getByText("待你定 · 1")).toBeVisible();
  await expect.element(page.getByText("线程 a")).toBeVisible();

  await userEvent.click(tab("唤醒 (2)"));
  await expect.element(page.getByText("已逾期 · 1")).toBeVisible();
  await expect.element(page.getByText("逾期 3 天")).toBeVisible();
  await expect.element(page.getByText("这件事已经过期")).toBeVisible();
  await expect.element(page.getByText("30 天内到期 · 1")).toBeVisible();
  await expect.element(page.getByText("这件事快到期")).toBeVisible();
  await expect.element(page.getByText("host/docs/B.md:9")).toBeVisible();
  await expect.element(page.getByText("线程 a")).not.toBeVisible();

  await userEvent.click(tab("收件·孤儿 (3)"));
  await expect.element(page.getByText("话题收件 · 2")).toBeVisible();
  await expect.element(page.getByText("待办话题")).toBeVisible();
  await expect.element(page.getByText("近 14 天零入链孤儿 · 1")).toBeVisible();
  await expect.element(page.getByText("扫 39 仓 · 已挂入口 3 · 隐私省略 9")).toBeVisible();
  await expect.element(page.getByText("[skills]")).toBeVisible();
  await expect.element(page.getByText("feat: 孤儿提交")).toBeVisible();

  // Only the topic whose source names a thread gets the open button.
  const open = page.getByRole("button", { name: "打开线程" });
  expect(open.elements()).toHaveLength(1);
  await userEvent.click(open);
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toContain(THREAD_UUID));
});

it("copies a path, and opens it where the server can", async () => {
  setup();
  hostReturns(digest());
  await using _screen = await render(<Harness entries={[]} cwd="/universe/files" />);
  await userEvent.click(trigger());
  await userEvent.click(tab("唤醒 (2)"));
  await userEvent.click(page.getByRole("button", { name: "复制路径" }).first());
  expect(mocks.copy).toHaveBeenCalledWith("host/docs/A.md");

  await userEvent.click(page.getByRole("button", { name: "打开", exact: true }).nth(1));
  expect(mocks.activate).toHaveBeenCalledWith("open", {
    environmentId,
    filePath: "host/docs/A.md",
    workspaceRoot: "/universe/files",
  });
});

it("leaves out the open button where files cannot be opened", async () => {
  setup();
  mocks.canOpen = false;
  hostReturns(digest());
  await using _screen = await render(<Harness entries={[]} cwd="/universe/noopen" />);
  await userEvent.click(trigger());
  await userEvent.click(tab("唤醒 (2)"));
  await expect.element(page.getByText("这件事已经过期")).toBeVisible();
  expect(page.getByRole("button", { name: "复制路径" }).elements()).toHaveLength(2);
  expect(
    page.getByRole("tabpanel").getByRole("button", { name: "打开", exact: true }).elements(),
  ).toHaveLength(0);
});

it("points at the wake tab when nothing waits but something is due soon", async () => {
  setup();
  hostReturns(digest());
  await using _screen = await render(<Harness entries={[]} cwd="/universe/hint" />);
  await userEvent.click(trigger());
  await expect.element(page.getByText("没有等你定的事")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /有 2 项逾期或 3 天内到期/ }));
  await expect.element(page.getByText("已逾期 · 1")).toBeVisible();
});

it("names the sources that failed", async () => {
  setup();
  hostReturns(digest({ upcoming: [], errors: ["due: timed out after 8000ms"] }));
  await using _screen = await render(<Harness entries={[]} cwd="/universe/errors" />);
  await userEvent.click(trigger());
  await userEvent.click(tab("唤醒 (1)"));
  await expect
    .element(page.getByText("部分来源读取失败：due: timed out after 8000ms"))
    .toBeVisible();
});

it("keeps a reply being typed when the digest arrives", async () => {
  setup();
  const digestReady = Promise.withResolvers<{ _tag: "Success"; value: { value: NeedsYouGtd } }>();
  mocks.hostCall.mockReturnValue(digestReady.promise);
  await using _screen = await render(
    <Harness entries={[entry("a", "reply")]} cwd="/universe/draft" />,
  );
  await userEvent.click(trigger());
  await userEvent.type(page.getByRole("textbox", { name: "自定义回复" }), "先并入周报");
  digestReady.resolve({ _tag: "Success", value: { value: digest() } });
  await expect.element(tab("唤醒 (2)")).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "自定义回复" })).toHaveValue("先并入周报");

  await userEvent.click(tab("唤醒 (2)"));
  await userEvent.click(tab("待定 (1)"));
  await expect.element(page.getByRole("textbox", { name: "自定义回复" })).toHaveValue("先并入周报");
});
