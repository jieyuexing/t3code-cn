import { EnvironmentId } from "@t3tools/contracts";
import { createAgent } from "@ui-sdk/react/agent";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { BerthThread, BerthView } from "./berths.logic";
import { BerthsBoard } from "./BerthsBoard";
import { BerthsPage } from "./BerthsPage";
import { readBerths, writeBerths } from "./berthsStorage";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  mountRelease: vi.fn(),
  mountFamily: vi.fn(),
  shells: [] as ReadonlyArray<unknown>,
  tasks: [] as ReadonlyArray<{ threadId: string | null }>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/threads")>();
  const { Atom } = await import("effect/reactivity");
  type MockShell = { readonly environmentId: string; readonly id: string };
  return {
    ...actual,
    threadFamilies: {
      ...actual.threadFamilies,
      mount: (...args: ReadonlyArray<unknown>) => {
        mocks.mountFamily(...args);
        return mocks.mountRelease;
      },
    },
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      quietThreadShellsAtom: Atom.make(() => []),
      threadRefsAtom: Atom.make(() =>
        (mocks.shells as ReadonlyArray<MockShell>).map((shell) => ({
          environmentId: shell.environmentId,
          threadId: shell.id,
        })),
      ),
      quietThreadShellAtom: (ref: { readonly environmentId: string; readonly threadId: string }) =>
        Atom.make(
          () =>
            (mocks.shells as ReadonlyArray<MockShell>).find(
              (shell) => shell.environmentId === ref.environmentId && shell.id === ref.threadId,
            ) ?? null,
        ),
    },
  };
});
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, scheduledTasksLive: () => ({}) },
  };
});
vi.mock("../state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/shell")>()),
  useEnvironmentShellStatus: () => "live",
}));
vi.mock("../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks }, error: null }),
}));
vi.mock("../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => "environment-a",
  useEnvironments: () => ({ environments: [{ environmentId: "environment-a", label: "本机" }] }),
}));

const environmentId = EnvironmentId.make("environment-a");

const thread = (id: string, over: Partial<BerthThread> = {}): BerthThread => ({
  threadId: id,
  title: `线程 ${id}`,
  displayTitle: `线程 ${id}`,
  status: "working",
  branch: null,
  snippet: null,
  updatedAt: "2026-11-25T08:00:00.000Z",
  createdAt: "2026-11-25T08:00:00.000Z",
  ...over,
});

const make = (threads: ReadonlyArray<BerthThread>, extra: Partial<BerthView> = {}): BerthView => ({
  threads,
  scheduled: [],
  subagents: new Map(),
  ...extra,
});

const board = (view: BerthView, ready = true) => (
  <BerthsBoard environmentId={environmentId} view={view} ready={ready} onOpen={mocks.navigate} />
);

const slotRow = (code: string) => page.getByRole("region", { name: `席位 ${code}` });

let allowAgentConfirm = false;
const agent = createAgent({
  allow: (step) => !step.confirm || allowAgentConfirm,
});

function fresh(): Disposable {
  localStorage.clear();
  allowAgentConfirm = false;
  mocks.navigate.mockReset();
  mocks.mountFamily.mockReset();
  mocks.mountRelease.mockReset();
  mocks.shells = [];
  mocks.tasks = [];
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("renders 6 fixed rows (E1, E2, 03–06), expands via accordion/shortcuts, and pins via searchable combobox", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["e1", null, "p3", null, null, null]);
  const view = make(
    [
      thread("e1", {
        title: "1125_GWH-350 SIR#91",
        displayTitle: "GWH-350 SIR#91",
        status: "input",
        snippet: "等待确认英文译法",
      }),
      thread("p3", { displayTitle: "轻量行为模型", status: "working" }),
      thread("e2", {
        title: "1125_NSNET-108 故障",
        displayTitle: "NSNET-108 故障",
        status: "failed",
      }),
    ],
    {
      subagents: new Map([
        [
          "e1",
          [
            thread("s1", { displayTitle: "校对三栏成稿", status: "approval" }),
            thread("s2", { displayTitle: "日志排查", status: "failed" }),
          ],
        ],
      ]),
    },
  );
  await using _screen = await render(board(view), { router: false });

  for (const code of ["E1", "E2", "03", "04", "05", "06"]) {
    await expect.element(slotRow(code)).toBeVisible();
  }
  await expect.element(slotRow("E1").getByText("等待确认英文译法")).not.toBeInTheDocument();

  // Single-key shortcut "1" expands E1 and dims other slots; Escape restores.
  await userEvent.keyboard("1");
  await expect.element(slotRow("E1").getByText("等待确认英文译法")).toBeVisible();
  await expect.element(slotRow("E1").getByText("校对三栏成稿")).toBeVisible();
  await expect.element(slotRow("03")).toHaveClass("opacity-40");
  await userEvent.keyboard("{Escape}");
  await expect.element(slotRow("E1").getByText("等待确认英文译法")).not.toBeInTheDocument();

  // Empty slot E2 uses a searchable ui-sdk Combobox; typing digits does not fire slot shortcuts.
  const e2Input = slotRow("E2").getByRole("combobox", { name: "钉入席位 E2" });
  await userEvent.click(e2Input);
  await userEvent.type(e2Input, "108");
  await userEvent.click(page.getByRole("option", { name: /NSNET-108 故障/ }));
  expect(readBerths(environmentId)).toEqual(["e1", "e2", "p3", null, null, null]);
});

it("empties a removed or settled slot in place without shifting neighboring rows", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", "b", "c", null, null, null]);
  const all = make([thread("a"), thread("b"), thread("c")]);
  await using screen = await render(board(all), { router: false });

  await userEvent.click(slotRow("E2").getByRole("button", { name: /线程 b/ }));
  await userEvent.click(slotRow("E2").getByRole("button", { name: "移出席位 E2" }));
  expect(readBerths(environmentId)).toEqual(["a", null, "c", null, null, null]);
  await expect.element(slotRow("E1").getByText("线程 a")).toBeVisible();
  await expect.element(slotRow("03").getByText("线程 c")).toBeVisible();

  await screen.rerender(board(make([thread("c")])));
  expect(readBerths(environmentId)).toEqual([null, null, "c", null, null, null]);
  await expect.element(slotRow("03").getByText("线程 c")).toBeVisible();
});

it("keeps saved slots while not authoritative and folds unseated and scheduled lists inside Collapsible", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", null, null, null, null, null]);
  await using screen = await render(board(make([]), false), { router: false });
  await expect.element(slotRow("E1").getByPlaceholder("读取中…")).toBeVisible();
  expect(readBerths(environmentId)).toEqual(["a", null, null, null, null, null]);

  await screen.rerender(
    board(
      make([thread("a"), thread("u1", { displayTitle: "未钉急事", status: "input" })], {
        scheduled: [thread("job", { displayTitle: "每日巡检", status: "failed" })],
      }),
      true,
    ),
  );
  await expect.element(page.getByText("未钉急事")).not.toBeInTheDocument();
  await expect.element(page.getByText("每日巡检")).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: /未钉线程（1）.*1 条待处理/ }));
  await expect.element(page.getByText("未钉急事")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /定时任务（1）.*1 条待处理/ }));
  await expect.element(page.getByText("每日巡检")).toBeVisible();
});

it("exposes named controls to ui-sdk createAgent and gates slot removal behind data-agent-confirm", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["e1", null, null, null, null, null]);
  const view = make([
    thread("e1", { displayTitle: "GWH-350 SIR#91", status: "input" }),
    thread("e2", { displayTitle: "NSNET-108 故障", status: "failed" }),
  ]);
  await using _screen = await render(board(view), { router: false });

  const components = agent
    .snapshot()
    .filter((entry) => !entry.offPage && entry.component !== "more");
  for (const entry of components) {
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  }
  const labels = components.map((entry) => entry.label);
  expect(labels).toContain("专注席位");
  expect(labels).toContain("钉入席位 E2");

  // Agent pins NSNET-108 into E2 through the Combobox API.
  const pinResult = await agent.act({
    steps: [{ ref: "钉入席位 E2", action: "setValue", args: ["NSNET-108 故障"] }],
  });
  expect(pinResult.ok, pinResult.error?.message).toBe(true);
  expect(readBerths(environmentId)).toEqual(["e1", "e2", null, null, null, null]);

  // Agent expands E1 and attempts to remove it: refused until human confirms, then succeeds.
  const openE1 = await agent.act({
    steps: [{ ref: "专注席位", action: "open", args: ["E1"] }],
  });
  expect(openE1.ok, openE1.error?.message).toBe(true);

  const refused = await agent.act({
    steps: [{ ref: "移出席位 E1", action: "press" }],
  });
  expect(refused.ok).toBe(false);
  expect(readBerths(environmentId)[0]).toBe("e1");

  allowAgentConfirm = true;
  const approved = await agent.act({
    steps: [{ ref: "移出席位 E1", action: "press" }],
  });
  expect(approved.ok, approved.error?.message).toBe(true);
  expect(readBerths(environmentId)).toEqual([null, "e2", null, null, null, null]);
});

it("mounts threadFamilies for seated threads, bypasses sidebar tag filtering, and navigates on open and subagent click", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", null, null, null, null, null]);
  mocks.shells = [
    {
      environmentId,
      id: "a",
      title: "1125_父线程",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "a" },
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      latestRun: null,
      lastVisitedAt: null,
      latestUserMessageAt: null,
      latestUserAuthoredMessageAt: null,
      source: { pendingRuntimeRequest: null, latestVisibleMessage: null },
      createdAt: "2026-11-25T08:00:00.000Z",
      updatedAt: "2026-11-25T08:00:00.000Z",
      branch: null,
    },
    {
      environmentId,
      id: "s",
      title: "待审批子代理",
      lineage: { parentThreadId: "a", relationshipToParent: "subagent", rootThreadId: "a" },
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      runtime: null,
      latestRun: null,
      lastVisitedAt: null,
      latestUserMessageAt: null,
      latestUserAuthoredMessageAt: null,
      source: { pendingRuntimeRequest: null, latestVisibleMessage: null },
      createdAt: "2026-11-25T09:00:00.000Z",
      updatedAt: "2026-11-25T09:00:00.000Z",
      branch: null,
    },
  ];
  await using _screen = await render(<BerthsPage />, { router: false });
  expect(mocks.mountFamily).toHaveBeenCalledTimes(1);
  expect(mocks.mountFamily.mock.calls[0]?.[2]).toBe("a");

  await userEvent.click(slotRow("E1").getByRole("button", { name: /父线程/ }));
  await userEvent.click(slotRow("E1").getByRole("button", { name: "打开子代理：待审批子代理" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "s" },
  });
  await userEvent.click(slotRow("E1").getByRole("button", { name: "打开处理：父线程" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "a" },
  });
});
