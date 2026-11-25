import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { BerthThread, BerthView } from "./berths.logic";
import { BerthsBoard } from "./BerthsBoard";
import { BerthsPage } from "./BerthsPage";
import { readBerths, writeBerths } from "./berthsStorage";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
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
  status: "working",
  model: "opus",
  branch: null,
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

const berth = (n: number) => page.getByRole("region", { name: `泊位 ${n}` });

function fresh(): Disposable {
  localStorage.clear();
  mocks.navigate.mockReset();
  mocks.shells = [];
  mocks.tasks = [];
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("places etech threads in the top priority zone and keeps empty berths clean behind a picker button", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", null, null, null, null, null]);
  const view = make(
    [
      thread("etech1", { title: "1125_GWH-350 work TET SIR#91", status: "input" }),
      thread("a", { branch: "feature/x" }),
      thread("b"),
    ],
    {
      subagents: new Map([
        [
          "a",
          [
            thread("s1", { title: "子代理一", status: "approval" }),
            thread("s2", { title: "子代理二", status: "working" }),
            thread("s3", { title: "子代理三", status: "failed" }),
            thread("s4", { title: "子代理四", status: "done" }),
          ],
        ],
      ]),
    },
  );
  await using _screen = await render(board(view), { router: false });
  const etechZone = page.getByRole("region", { name: "ETECH 优先区" });
  await expect.element(etechZone.getByText("1125_GWH-350 work TET SIR#91")).toBeVisible();
  for (let n = 1; n <= 6; n++) await expect.element(berth(n)).toBeVisible();
  await expect.element(berth(1).getByText("线程 a")).toBeVisible();
  await expect.element(berth(1).getByText("子代理一")).toBeVisible();
  // Four subagents stay inside the fixed h-44 scrollable card container.
  await expect.element(berth(1)).toHaveClass("h-44", "overflow-hidden");
  await expect.element(berth(2)).toHaveClass("h-44", "overflow-hidden");
  await expect.element(berth(1).getByRole("list")).toHaveClass("overflow-y-auto");
  // Empty berths do not duplicate off-berth thread titles until the picker button is clicked.
  await expect.element(berth(2).getByText("线程 b")).not.toBeInTheDocument();
  await userEvent.click(berth(2).getByRole("button", { name: "选线程入坞" }));
  await userEvent.click(berth(2).getByRole("button", { name: "线程 b" }));
  await expect.element(berth(2).getByText("线程 b")).toBeVisible();
  expect(readBerths(environmentId)).toEqual(["a", "b", null, null, null, null]);
});

it("seats off-berth threads in the first empty berth and leaves a berth empty without moving the others", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", null, null, null, null, null]);
  await using _screen = await render(board(make([thread("a"), thread("b"), thread("c")])), {
    router: false,
  });
  const off = page.getByRole("region", { name: "港外待入坞" });
  await userEvent.click(off.getByRole("button", { name: "入泊位" }).first());
  await userEvent.click(
    page.getByRole("region", { name: "港外待入坞" }).getByRole("button", { name: "入泊位" }),
  );
  expect(readBerths(environmentId)).toEqual(["a", "b", "c", null, null, null]);

  await userEvent.click(berth(2).getByRole("button", { name: "移出" }));
  await expect.element(berth(2).getByText("泊位 2 · 空闲 · 主力")).toBeVisible();
  await expect.element(berth(1).getByText("线程 a")).toBeVisible();
  await expect.element(berth(3).getByText("线程 c")).toBeVisible();
  expect(readBerths(environmentId)).toEqual(["a", null, "c", null, null, null]);
  await expect.element(off.getByText("线程 b")).toBeVisible();
});

it("empties the berth of a thread that left play in place, keeps it out when it returns, and never seats a new one", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", "b", "c", null, null, null]);
  const all = make([thread("a"), thread("b"), thread("c")]);
  await using screen = await render(board(all), { router: false });
  await screen.rerender(board(make([thread("a"), thread("c"), thread("new")])));
  await expect.element(berth(2).getByText("泊位 2 · 空闲 · 主力")).toBeVisible();
  await expect.element(berth(1).getByText("线程 a")).toBeVisible();
  await expect.element(berth(3).getByText("线程 c")).toBeVisible();
  await expect.element(berth(4).getByText("泊位 4 · 空闲 · 副位")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "港外待入坞" }).getByText("线程 new"))
    .toBeVisible();
  expect(readBerths(environmentId)).toEqual(["a", null, "c", null, null, null]);

  await screen.rerender(board(all));
  await expect.element(berth(2).getByText("泊位 2 · 空闲 · 主力")).toBeVisible();
});

it("keeps the saved berths while the thread list is not live yet", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", "b", null, null, null, null]);
  await using screen = await render(board(make([]), false), { router: false });
  await expect.element(berth(1).getByText("泊位 1 · 读取中 · 主力")).toBeVisible();
  expect(readBerths(environmentId)).toEqual(["a", "b", null, null, null, null]);
  await screen.rerender(board(make([thread("a"), thread("b")]), true));
  await expect.element(berth(2).getByText("线程 b")).toBeVisible();
});

it("replaces a berth through the 1–6 picker when all six are taken", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", "b", "c", "d", "e", "f"]);
  const view = make(["a", "b", "c", "d", "e", "f", "g"].map((id) => thread(id)));
  await using _screen = await render(board(view), { router: false });
  await userEvent.click(page.getByRole("button", { name: "入泊位" }));
  await userEvent.click(page.getByRole("button", { name: "放入泊位 3" }));
  await expect.element(berth(3).getByText("线程 g")).toBeVisible();
  await expect.element(berth(4).getByText("线程 d")).toBeVisible();
});

it("keeps scheduled-task threads in a folded section until asked", async () => {
  using _fresh = fresh();
  const view = make([], { scheduled: [thread("job", { title: "每日巡检", status: "failed" })] });
  await using _screen = await render(board(view), { router: false });
  await expect.element(page.getByText("每日巡检")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: /定时任务线程（1）.*1 条需要处理/ }));
  await expect.element(page.getByText("每日巡检")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "入泊位" }));
  await expect.element(berth(1).getByText("每日巡检")).toBeVisible();
});

it("opens a parent thread and a subagent in the native thread route even when tag filtering empties quietThreadShellsAtom", async () => {
  using _fresh = fresh();
  writeBerths(environmentId, ["a", null, null, null, null, null]);
  mocks.shells = [
    {
      environmentId,
      id: "a",
      title: "父线程",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "a" },
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      source: { pendingRuntimeRequest: null },
      createdAt: "2026-11-25T08:00:00.000Z",
      modelSelection: { instanceId: "claude", model: "opus" },
      branch: null,
    },
    {
      environmentId,
      id: "s",
      title: "子代理",
      lineage: { parentThreadId: "a", relationshipToParent: "subagent", rootThreadId: "a" },
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      source: { pendingRuntimeRequest: null },
      createdAt: "2026-11-25T09:00:00.000Z",
      modelSelection: { instanceId: "claude", model: "haiku" },
      branch: null,
    },
  ];
  await using _screen = await render(<BerthsPage />, { router: false });
  await userEvent.click(berth(1).getByRole("button", { name: "父线程" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "a" },
  });
  await userEvent.click(berth(1).getByRole("button", { name: "子代理" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "s" },
  });
});
