import {
  EnvironmentId,
  type LocalReviewCommit,
  type LocalReviewLogInput,
  type LocalReviewLogResult,
  type ReviewDiffFileStat,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { LocalReviewPage } from "./LocalReviewPage";
import { LocalReviewSourceSwitch } from "./LocalReviewSourceSwitch";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  log: null as null | ((input: LocalReviewLogInput) => LocalReviewLogResult),
  logInputs: [] as Array<LocalReviewLogInput>,
  previewInputs: [] as Array<unknown>,
  files: [] as ReadonlyArray<ReviewDiffFileStat>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock("./localReviewState", () => ({
  localReviewEnvironment: {
    log: (args: { input: LocalReviewLogInput }) => ({ kind: "log", args }),
  },
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: (args: { input: unknown }) => ({ kind: "preview", args }),
    diffFilePatch: (args: unknown) => ({ kind: "patch", args }),
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; args: { input: never } } | null) => {
    if (atom === null) return { data: null, error: null, isPending: false, refresh: () => {} };
    let data: unknown = null;
    if (atom.kind === "log") {
      mocks.logInputs.push(atom.args.input);
      data = mocks.log?.(atom.args.input) ?? null;
    } else if (atom.kind === "preview") {
      mocks.previewInputs.push(atom.args.input);
      data = { sources: [{ files: mocks.files }] };
    } else {
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

const environmentId = EnvironmentId.make("environment");
const REPOS = [
  { path: "/u", name: "universe" },
  { path: "/u/projects/t3code-cn", name: "projects/t3code-cn" },
];

const commit = (
  repo: string,
  hash: string,
  subject: string,
  extra: Partial<LocalReviewCommit> = {},
): LocalReviewCommit => ({
  repo,
  hash: hash.repeat(40).slice(0, 40),
  parents: ["p".repeat(40)],
  subject,
  message: subject,
  author: "作者",
  committedAt: "2027-01-15T08:00:00.000Z",
  refs: [],
  ...extra,
});

const file = (
  path: string,
  changeType: NonNullable<ReviewDiffFileStat["changeType"]>,
): ReviewDiffFileStat => ({
  path,
  previousPath: null,
  changeType,
  additions: 3,
  deletions: 1,
});

const dirtyList = [{ repo: "/u/projects/t3code-cn", changeCount: 4 }];

function serve(commits: ReadonlyArray<LocalReviewCommit>) {
  mocks.logInputs = [];
  mocks.previewInputs = [];
  mocks.log = (input) => {
    const own = commits.filter((c) => input.repo === undefined || c.repo === input.repo);
    return input.part === "dirty"
      ? { repos: REPOS, commits: [], dirty: dirtyList, hasMore: false }
      : {
          repos: REPOS,
          commits: own.slice(0, input.limit),
          dirty: [],
          hasMore: own.length > (input.limit ?? 0),
        };
  };
}

it("lists commits of all repos, narrows to one repo, shows a commit's files and a file's diff", async () => {
  serve([
    commit("/u/projects/t3code-cn", "a", "feat: 履历页", {
      message: "feat: 履历页\n\n正文第二段",
      refs: ["main"],
    }),
    commit("/u", "b", "merge: 合并分支", { parents: ["1".repeat(40), "2".repeat(40)] }),
  ]);
  mocks.files = [file("src/a.ts", "change"), file("src/new.ts", "new")];
  await using screen = await render(<LocalReviewPage environmentId={environmentId} />, {
    router: "/",
  });
  await expect.element(page.getByText("未提交改动 · t3code-cn · 4 项")).toBeVisible();
  await expect.element(page.getByText("合并", { exact: true })).toBeVisible();
  await expect.element(page.getByText("main", { exact: true })).toBeVisible();

  await userEvent.click(page.getByText("feat: 履历页").first());
  await expect.element(page.getByText("正文第二段")).toBeVisible();
  await expect.element(page.getByText("改动的文件 · 2")).toBeVisible();
  await expect.element(page.getByText("新增")).toBeVisible();
  expect(mocks.previewInputs.at(-1)).toMatchObject({
    cwd: "/u/projects/t3code-cn",
    commitSha: "a".repeat(40),
    metadataOnly: true,
  });
  await expect.element(page.getByText("const changed = 1;")).not.toBeInTheDocument();
  await userEvent.click(page.getByText("src/a.ts"));
  await expect.element(page.getByText("const changed = 1;")).toBeVisible();

  await userEvent.click(page.getByText("未提交改动 · t3code-cn · 4 项"));
  await expect.element(page.getByText("工作区相对 HEAD，含未跟踪文件。")).toBeVisible();
  expect(mocks.previewInputs.at(-1)).toMatchObject({ sourceKind: "working-tree" });

  await userEvent.click(page.getByRole("combobox", { name: "选择仓" }));
  await userEvent.click(page.getByRole("option", { name: "universe" }));
  await expect.element(page.getByText("merge: 合并分支")).toBeVisible();
  expect(mocks.logInputs).toContainEqual({ part: "commits", limit: 50, repo: "/u" });
  void screen;
});

it("loads more commits", async () => {
  serve(
    Array.from({ length: 51 }, (_, i) =>
      commit("/u", "c", `提交 ${i + 1}`, { hash: `${i}`.padStart(40, "0") }),
    ),
  );
  await using screen = await render(<LocalReviewPage environmentId={environmentId} />, {
    router: "/",
  });
  await expect.element(page.getByText("提交 50", { exact: true })).toBeVisible();
  await expect.element(page.getByText("提交 51", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "加载更多" }));
  await expect.element(page.getByText("提交 51", { exact: true })).toBeVisible();
  expect(mocks.logInputs).toContainEqual({ part: "commits", limit: 100 });
  void screen;
});

it("explains a repo without commits", async () => {
  serve([]);
  mocks.log = () => ({ repos: REPOS, commits: [], dirty: [], hasMore: false });
  await using screen = await render(<LocalReviewPage environmentId={environmentId} />, {
    router: "/",
  });
  await expect.element(page.getByText("还没有提交。")).toBeVisible();
  void screen;
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
