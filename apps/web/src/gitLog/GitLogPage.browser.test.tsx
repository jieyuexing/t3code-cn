import {
  EnvironmentId,
  type GitLogCommit,
  type GitLogListInput,
  type GitLogListResult,
  type ReviewDiffFileStat,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { GitLogPage } from "./GitLogPage";
import { GitLogSourceSwitch } from "./GitLogSourceSwitch";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  list: null as null | ((input: GitLogListInput) => GitLogListResult),
  listInputs: [] as Array<GitLogListInput>,
  previewInputs: [] as Array<unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("./gitLogState", () => ({
  gitLogEnvironment: { list: (args: { input: GitLogListInput }) => ({ kind: "list", args }) },
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: (args: { input: unknown }) => ({ kind: "preview", args }),
    diffFilePatch: (args: unknown) => ({ kind: "patch", args }),
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; args: { input: never } } | null) => {
    let data: unknown = null;
    if (atom?.kind === "list") {
      mocks.listInputs.push(atom.args.input);
      data = mocks.list?.(atom.args.input) ?? null;
    } else if (atom?.kind === "preview") {
      mocks.previewInputs.push(atom.args.input);
      data = { sources: [{ files: FILES }] };
    } else if (atom?.kind === "patch") {
      data = { diff: PATCH };
    }
    return { data, error: null, isPending: false, refresh: () => {} };
  },
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

const FILES: ReadonlyArray<ReviewDiffFileStat> = [
  { path: "src/a.ts", previousPath: null, changeType: "change", additions: 3, deletions: 1 },
  { path: "docs/new.md", previousPath: null, changeType: "new", additions: 2, deletions: 0 },
  { path: "old.md", previousPath: null, changeType: "deleted", additions: 0, deletions: 4 },
  {
    path: "b/renamed.md",
    previousPath: "a/was.md",
    changeType: "rename-pure",
    additions: 0,
    deletions: 0,
  },
];

const environmentId = EnvironmentId.make("environment");
const REPOS = [
  { path: "/u", name: "universe" },
  { path: "/u/projects/notes", name: "projects/notes" },
];

const commit = (
  hash: string,
  subject: string,
  parents: string[],
  refs: string[] = [],
): GitLogCommit => ({
  hash: hash.repeat(40).slice(0, 40),
  parents,
  subject,
  author: "作者",
  committedAt: "2027-01-15T08:00:00.000Z",
  refs,
});

const HISTORY = [
  commit("a", "合并 topic 分支", ["b".repeat(40), "c".repeat(40)], ["main"]),
  commit("b", "主线上的一次改动", ["d".repeat(40)]),
  commit("c", "分支上的改动", ["d".repeat(40)], ["topic"]),
  commit("d", "初始提交", [], ["v1"]),
];

function serve(history: ReadonlyArray<GitLogCommit>) {
  mocks.listInputs = [];
  mocks.previewInputs = [];
  mocks.list = (input) => {
    const needle = input.query?.toLowerCase();
    const own = history.filter((c) => needle === undefined || c.subject.includes(needle));
    return {
      repos: REPOS,
      repo: input.repo ?? "/u",
      commits: own.slice(0, input.limit),
      hasMore: own.length > (input.limit ?? 0),
    };
  };
}

it("shows the branch graph, a commit's files and a file's diff, and switches repo, filters and pages", async () => {
  serve(HISTORY);
  await using screen = await render(<GitLogPage environmentId={environmentId} />, { router: "/" });
  await expect.element(page.getByText("合并 topic 分支").first()).toBeVisible();
  expect(document.querySelectorAll("svg circle").length).toBeGreaterThanOrEqual(HISTORY.length);
  await expect.element(page.getByText("topic", { exact: true })).toBeVisible();
  await expect.element(page.getByText("v1", { exact: true })).toBeVisible();

  // The newest commit is selected: its author · time · subject line and all its files show, no diff yet.
  await expect.element(page.getByRole("listbox", { name: "提交的文件" })).toBeVisible();
  for (const letter of ["M", "A", "D", "R"]) {
    await expect.element(page.getByText(letter, { exact: true }).first()).toBeVisible();
  }
  expect(mocks.previewInputs.at(-1)).toMatchObject({
    cwd: "/u",
    commitSha: "a".repeat(40),
    metadataOnly: true,
  });
  await expect.element(page.getByText("const changed = 1;")).not.toBeInTheDocument();

  await userEvent.click(page.getByText("a/was.md → b/renamed.md"));
  await userEvent.click(page.getByRole("option", { name: /^M.*a\.ts/ }));
  await expect.element(page.getByText("const changed = 1;")).toBeVisible();

  await userEvent.click(page.getByText("初始提交"));
  expect(mocks.previewInputs.at(-1)).toMatchObject({ commitSha: "d".repeat(40) });

  await userEvent.click(page.getByRole("combobox", { name: "选择仓" }));
  await userEvent.click(page.getByRole("option", { name: "projects/notes" }));
  expect(mocks.listInputs).toContainEqual({ limit: 100, repo: "/u/projects/notes" });

  await userEvent.fill(page.getByRole("textbox", { name: "筛选" }), "分支");
  await vi.waitFor(() => expect(mocks.listInputs.at(-1)).toMatchObject({ query: "分支" }));
  void screen;
});

it("loads older commits on demand", async () => {
  serve(
    Array.from({ length: 101 }, (_, i) => commit(`${i}`.padStart(2, "0"), `提交 ${i + 1}`, [])),
  );
  await using screen = await render(<GitLogPage environmentId={environmentId} />, { router: "/" });
  await expect.element(page.getByText("提交 100", { exact: true })).toBeVisible();
  await expect.element(page.getByText("提交 101", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "加载更早…" }));
  await expect.element(page.getByText("提交 101", { exact: true })).toBeVisible();
  expect(mocks.listInputs).toContainEqual({ limit: 200 });
  void screen;
});

it("explains a repo without commits", async () => {
  serve([]);
  await using screen = await render(<GitLogPage environmentId={environmentId} />, { router: "/" });
  await expect.element(page.getByText("没有提交。")).toBeVisible();
  void screen;
});

it("switches between Git log and pull requests through the route search", async () => {
  mocks.navigate.mockClear();
  await using screen = await render(<GitLogSourceSwitch active="git" />, { router: "/" });
  await userEvent.click(page.getByRole("tab", { name: "拉取请求" }));
  await userEvent.click(page.getByRole("tab", { name: "Git 日志" }));
  const [toPullRequests, toGit] = mocks.navigate.mock.calls.map(
    (call) => call[0] as { search: (previous: Record<string, unknown>) => Record<string, unknown> },
  );
  expect(
    toPullRequests?.search({ source: "git", involvement: "all", state: "open" }),
  ).not.toHaveProperty("source");
  expect(toGit?.search({ involvement: "all", state: "open" })).toMatchObject({ source: "git" });
  void screen;
});
