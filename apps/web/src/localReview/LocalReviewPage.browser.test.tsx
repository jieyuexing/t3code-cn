import {
  EnvironmentId,
  ThreadId,
  type LocalReviewGetResult,
  type LocalReviewRequestHead,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { LocalReviewPage } from "./LocalReviewPage";
import { LocalReviewSourceSwitch } from "./LocalReviewSourceSwitch";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  heads: [] as ReadonlyArray<unknown>,
  detail: null as unknown,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("./localReviewState", () => ({
  localReviewEnvironment: {
    list: (args: unknown) => ({ kind: "list", args }),
    get: (args: unknown) => ({ kind: "get", args }),
  },
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: { diffFilePatch: (args: unknown) => ({ kind: "patch", args }) },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom === null
        ? null
        : atom.kind === "list"
          ? { requests: mocks.heads, nextCursor: null }
          : atom.kind === "get"
            ? mocks.detail
            : { diff: PATCH },
    error: null,
  }),
}));

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " const keep = 1;",
  "-const old = 1;",
  "+const changed = 1;",
  "",
].join("\n");

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread-a");

const head = (
  requestId: string,
  threadTitle: string,
  requestTitle = "",
  startedAt = "2027-01-15T08:00:00.000Z",
): LocalReviewRequestHead => ({
  requestId,
  threadId,
  threadTitle,
  requestTitle,
  startedAt,
  endedAt: "2027-01-15T08:05:00.000Z",
  runCount: 2,
  origin: "user",
  childCount: 1,
  fileChangeCount: 1,
  commitCommandCount: 2,
});

const detail = (): LocalReviewGetResult => ({
  head: head("request-1", "插件线程"),
  files: [
    {
      repo: "/u/t3code-cn",
      path: "src/a.ts",
      sources: ["checkpoint", "output", "child"],
      commits: ["c".repeat(40)],
      state: { kind: "committed", hash: "c".repeat(40) },
    },
    {
      repo: "/u/t3-rss-plugin",
      path: "plugin.json",
      sources: ["output"],
      commits: [],
      state: { kind: "uncommitted" },
    },
  ],
  commits: [
    {
      repo: "/u/t3code-cn",
      hash: "c".repeat(40),
      subject: "feat: 应用栏",
      time: 1,
      role: "output",
      orphan: false,
      mergedAs: null,
      mergedVia: null,
      alsoIn: [],
      fromChild: true,
    },
  ],
  deliverables: ["/u/.local/tmp/plan.html"],
  mentionedCommits: 0,
  clearedWorktrees: 0,
  omittedFiles: 0,
  blindSpots: [],
  gitCalls: 3,
  complete: true,
});

it("lists requests, shows the files of the selected one and a file's diff", async () => {
  mocks.heads = [
    head("request-1", "插件线程", "应用栏改成直白的来源标签", "2027-01-15T08:07:00.000Z"),
    head("request-2", "插件线程", "先看一下列表怎么分", "2027-01-15T06:30:00.000Z"),
  ];
  mocks.detail = detail();
  await using screen = await render(
    <LocalReviewPage environmentId={environmentId} threadId={undefined} />,
    { router: "/" },
  );
  await expect.element(page.getByText("插件线程", { exact: true }).first()).toBeVisible();
  await expect.element(page.getByText("应用栏改成直白的来源标签")).toBeVisible();
  await expect.element(page.getByText("先看一下列表怎么分")).toBeVisible();
  await expect.element(page.getByText(/^01-15 \d\d:07$/)).toBeVisible();
  await expect.element(page.getByText(/已识别 2 个文件/)).toBeVisible();
  await expect.element(page.getByText("现仍未提交")).toBeVisible();
  await expect.element(page.getByText("本次提交").first()).toBeVisible();
  await expect.element(page.getByText("总仓快照").first()).toBeVisible();
  await userEvent.hover(page.getByText("总仓快照").first());
  await expect.element(page.getByText(/每轮结束时对总仓工作区拍的快照/).last()).toBeVisible();
  await expect.element(page.getByText("/u/.local/tmp/plan.html")).toBeVisible();

  await userEvent.click(page.getByText("src/a.ts"));
  await expect.element(page.getByText("返回清单")).toBeVisible();
  await expect.element(page.getByText("feat: 应用栏")).toBeVisible();
  await expect.element(page.getByText("const changed = 1;")).toBeVisible();

  await userEvent.click(page.getByText("返回清单"));
  await expect.element(page.getByText(/已识别 2 个文件/)).toBeVisible();
  void screen;
});

it("explains an empty list and an empty request", async () => {
  mocks.heads = [];
  mocks.detail = null;
  await using empty = await render(
    <LocalReviewPage environmentId={environmentId} threadId={undefined} />,
    { router: "/" },
  );
  await expect.element(page.getByText(/没有识别到改动的请求/)).toBeVisible();
  void empty;
});

it("switches between pull requests and local through the route search", async () => {
  mocks.navigate.mockClear();
  await using screen = await render(<LocalReviewSourceSwitch active="pull-requests" />, {
    router: "/",
  });
  await userEvent.click(page.getByRole("tab", { name: "本地" }));
  const call = mocks.navigate.mock.calls[0]?.[0] as {
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  expect(call.search({ involvement: "all", state: "open" })).toMatchObject({ source: "local" });
  void screen;
});
