// @effect-diagnostics nodeBuiltinImport:off globalDate:off - 剧本在录制前同步读本机插件缓存，并按当下时间标记缓存新鲜度。
// 展示剧本：演示 home 里装哪些插件、放哪些项目与线程、按什么顺序点哪里。
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Page } from "playwright-core";

import type { HistoryOp } from "./history.ts";
import { MAIL_USER, type DemoMail } from "./mail.ts";

/** 步骤的 after 钩子拿到的现场：页面与演示邮箱（剧本没有邮箱时为 null）。 */
export interface StepContext {
  readonly page: Page;
  readonly mail: DemoMail | null;
}

export interface Step {
  readonly label: string;
  /** CSS 选择器；合成时光标移到它的中心，默认还会点它。 */
  readonly target?: string;
  readonly click?: false;
  /** 目标在这个 iframe（插件面板）里；坐标仍按整页计。 */
  readonly frame?: string;
  /** 点击次数，3 表示三击选中一段。 */
  readonly clicks?: number;
  readonly key?: string;
  /** 点击之后、截图之前执行：等画面到位，或做点击在外部世界引起的变化。 */
  readonly after?: (context: StepContext) => Promise<void>;
  /** 这一拍镜头框住的区域（CSS 像素，按 16:9 补齐），缺省为整屏。 */
  readonly zoom?: { readonly x: number; readonly y: number; readonly w: number };
  readonly settle?: number;
  readonly hold?: number;
}

interface Story {
  readonly plugins: ReadonlyArray<string>;
  readonly rail: ReadonlyArray<unknown>;
  readonly pluginData: (demo: { readonly mailPort: number }) => Record<string, unknown>;
  /** 线程用「需要审批」的运行模式，回放里的审批请求才会停下等用户。 */
  readonly supervised?: true;
  /** 录第一帧之前跑一遍：让插件子进程先读完钥匙串、连上邮箱，正式一拍里面板秒开。 */
  readonly prepare?: (context: StepContext) => Promise<void>;
  readonly mailAccountId?: string;
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly files: Record<string, string>;
    readonly history?: ReadonlyArray<HistoryOp>;
    readonly threads: ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly model: string;
      readonly messages: ReadonlyArray<string>;
    }>;
  }>;
  readonly open: string;
  readonly steps: ReadonlyArray<Step>;
}

const universe = NodePath.resolve(import.meta.dirname, "../../../../..");
const rssPlugin = NodePath.join(universe, "projects/personal/t3-plugins/t3-rss-plugin");
export const mailPlugin = NodePath.join(universe, "projects/personal/t3-plugins/t3-mail-plugin");

/** 只取公开技术源的本机缓存，订阅列表里的其他源不进演示。 */
const PUBLIC_FEEDS = ["martinfowler.com", "vercel.com", "atlasnote.ai"];
function rssDemoData() {
  const live = NodePath.join(NodeOS.homedir(), ".t3/userdata/plugins/data/t3-rss.json");
  if (!NodeFS.existsSync(live)) return {};
  const { storage } = JSON.parse(NodeFS.readFileSync(live, "utf8"));
  const feeds = (
    storage.feeds as Array<{ id: string; url: string; error?: string; failedAt?: string }>
  ).filter((feed) => PUBLIC_FEEDS.some((host) => feed.url.includes(host)));
  // 标成刚抓过：打开面板不再联网刷新，画面不随上游新文章变。
  const fetchedAt = new Date().toISOString();
  const picked: Record<string, unknown> = {
    feeds: feeds.map(({ error: _error, failedAt: _failedAt, ...feed }) => ({
      ...feed,
      lastFetchedAt: fetchedAt,
    })),
    settings: { translate: false },
  };
  for (const feed of feeds) {
    picked[`feed.${feed.id}`] = { ...storage[`feed.${feed.id}`], fetchedAt };
  }
  return { "t3-rss": { settings: {}, storage: picked } };
}

// 固定不变：钥匙串里的常驻演示条目按它命名，换 id 就会多出一条。
const MAIL_ACCOUNT = "showcase-demo";

/** 邮箱账号指向本机合成 IMAP；密码在测试专用的钥匙串条目里，不在这里。 */
const mailDemoData = (port: number) => ({
  "t3-mail": {
    settings: {},
    storage: {
      accounts: [
        {
          id: MAIL_ACCOUNT,
          provider: "other",
          address: MAIL_USER,
          username: MAIL_USER,
          host: "127.0.0.1",
          port,
          secure: false,
          createdAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    },
  },
});

const rail = (title: string) => `[aria-label="App rail"] [aria-label="${title}"]`;

const acme = {
  "package.json": JSON.stringify(
    { name: "acme-dashboard", private: true, scripts: { test: "vitest" } },
    null,
    2,
  ),
  "server/package.json": JSON.stringify({ name: "@acme/server", type: "module" }, null, 2),
  "server/src/math.ts": "export const sum = (a: number, b: number) => a + b;\n",
  "web/src/App.tsx": "export function App() {\n  return <main>Acme</main>;\n}\n",
  "README.md": "# Acme Dashboard\n\nInternal metrics for the Acme team.\n",
};

const RSS_FRAME = 'iframe[title="订阅"]';
const MAIL_FRAME = 'iframe[title="邮箱"]';
const needsYouRow = (title: string) => `[aria-label="待你定"] li:has-text("${title}")`;

/** 两个能表现分支图的提交序列：功能分支、修复分支各一条，合并回 main，作者各不相同。 */
const acmeHistory: ReadonlyArray<HistoryOp> = [
  { commit: "chore: scaffold the dashboard", by: "Mei Lin", at: "2026-10-26T09:12:00+08:00" },
  {
    commit: "test(server): cover sum",
    by: "Tomás Rivera",
    at: "2026-10-27T14:03:00+08:00",
    files: {
      "server/src/math.test.ts":
        'import { sum } from "./math";\n\ntest("sum", () => expect(sum(1, 2)).toBe(3));\n',
    },
  },
  {
    commit: "feat(web): app shell and routing",
    by: "Priya Nair",
    at: "2026-10-28T11:20:00+08:00",
    files: { "web/src/routes.tsx": "export const routes = ['/', '/metrics'];\n" },
  },
  { branch: "feature/billing" },
  {
    commit: "feat(billing): invoice list page",
    by: "Priya Nair",
    at: "2026-10-30T16:45:00+08:00",
    files: { "web/src/billing/InvoiceList.tsx": "export const InvoiceList = () => null;\n" },
  },
  { checkout: "main" },
  {
    commit: "fix(server): empty metrics window no longer throws",
    by: "Jonas Weber",
    at: "2026-10-31T10:08:00+08:00",
    files: { "server/src/metrics.ts": "export const window = (n: number) => (n > 0 ? n : 1);\n" },
  },
  { checkout: "feature/billing" },
  {
    commit: "feat(billing): payment form",
    by: "Mei Lin",
    at: "2026-11-02T15:30:00+08:00",
    files: { "web/src/billing/PaymentForm.tsx": "export const PaymentForm = () => null;\n" },
  },
  { checkout: "main" },
  { branch: "fix/login-flaky" },
  {
    commit: "test(login): wait for the session cookie",
    by: "Tomás Rivera",
    at: "2026-11-03T09:41:00+08:00",
    files: { "web/src/login.test.ts": "test('login', () => {});\n" },
  },
  {
    commit: "fix(login): retry the token refresh once",
    by: "Tomás Rivera",
    at: "2026-11-03T17:22:00+08:00",
    files: { "web/src/session.ts": "export const refresh = () => retry(1);\n" },
  },
  { checkout: "main" },
  {
    commit: "chore: bump vitest",
    by: "Jonas Weber",
    at: "2026-11-04T13:05:00+08:00",
    files: {
      "package.json": JSON.stringify(
        {
          name: "acme-dashboard",
          private: true,
          scripts: { test: "vitest" },
          devDependencies: { vitest: "^4.1.0" },
        },
        null,
        2,
      ),
    },
  },
  {
    merge: "fix/login-flaky",
    by: "Mei Lin",
    at: "2026-11-05T10:00:00+08:00",
    message: "Merge branch 'fix/login-flaky'",
  },
  { checkout: "feature/billing" },
  {
    commit: "feat(billing): receipt download",
    by: "Priya Nair",
    at: "2026-11-06T11:15:00+08:00",
    files: { "web/src/billing/Receipt.tsx": "export const Receipt = () => null;\n" },
  },
  { checkout: "main" },
  {
    commit: "docs: describe the metrics API",
    by: "Jonas Weber",
    at: "2026-11-09T09:30:00+08:00",
    files: { "docs/metrics.md": "# Metrics API\n\nGET /metrics?window=7d\n" },
  },
  {
    merge: "feature/billing",
    by: "Mei Lin",
    at: "2026-11-10T18:20:00+08:00",
    message: "Merge pull request #12 from feature/billing",
  },
  {
    commit: "perf(web): memoize chart series",
    by: "Tomás Rivera",
    at: "2026-11-12T10:47:00+08:00",
    files: { "web/src/chart.ts": "export const series = memo(build);\n" },
  },
];

const plugins: Story = {
  plugins: [rssPlugin, mailPlugin],
  rail: [
    { _tag: "builtin", id: "needsYou" },
    { _tag: "builtin", id: "browser" },
    { _tag: "builtin", id: "terminal" },
    { _tag: "builtin", id: "files" },
    { _tag: "builtin", id: "diff" },
    { _tag: "plugin", pluginId: "t3-rss", viewId: "panel", title: "订阅" },
    { _tag: "plugin", pluginId: "t3-mail", viewId: "mailbox", title: "邮箱" },
  ],
  supervised: true,
  mailAccountId: MAIL_ACCOUNT,
  // 系统钥匙串首次读取在这台机器上要几秒，偶尔更久：先在镜头外读一次，插件进程会记住密码。
  prepare: async ({ page }) => {
    const inbox = page.frameLocator(MAIL_FRAME).locator("text=Frontend Weekly").first();
    await page.locator(rail("邮箱")).click();
    for (let attempt = 0; ; attempt++) {
      try {
        await inbox.waitFor({ timeout: 40_000 });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await page.frameLocator(MAIL_FRAME).locator('[aria-label="刷新"]').click();
      }
    }
    await page.locator(rail("邮箱")).click();
    await page.locator(MAIL_FRAME).waitFor({ state: "detached" });
  },
  pluginData: ({ mailPort }) => ({ ...rssDemoData(), ...mailDemoData(mailPort) }),
  projects: [
    {
      name: "pocket-notes",
      files: { "README.md": "# Pocket Notes\n\nOffline-first notes.\n" },
      threads: [
        {
          key: "mail",
          title: "Archive the newsletters",
          model: "showcase-mail",
          messages: ["Archive the newsletters in my inbox"],
        },
      ],
    },
    {
      name: "acme-dashboard",
      files: acme,
      history: acmeHistory,
      threads: [
        {
          key: "question",
          title: "Pick a base branch for billing",
          model: "showcase-question",
          messages: ["Which branch should the billing page refactor start from?"],
        },
        {
          key: "reply",
          title: "Split the invoice migration",
          model: "showcase-reply",
          messages: ["Split the invoice migration into safe steps"],
        },
        {
          key: "plan",
          title: "Plan the billing page refactor",
          model: "todo-list",
          messages: ["Plan the billing page refactor"],
        },
      ],
    },
  ],
  open: "plan",
  steps: [
    { label: "overview", hold: 1.6 },
    { label: "needs-you", target: rail("Needs you"), hold: 1.0 },
    {
      label: "follow",
      target: `${needsYouRow("Split the invoice migration")} >> button:has-text("按推荐")`,
      settle: 800,
      hold: 1.0,
    },
    {
      label: "open-question",
      target: `${needsYouRow("Pick a base branch")} >> text=打开线程`,
      settle: 1200,
      hold: 0.8,
    },
    {
      label: "answer",
      target: 'button:has-text("main (Recommended)")',
      settle: 1800,
      hold: 1.0,
    },
    {
      label: "proceed",
      target: '[data-thread-item]:has-text("Split the invoice migration")',
      settle: 2500,
      hold: 1.4,
      // 侧栏重排后鼠标会落在别的线程行上，悬停按钮留在画面里。
      after: async ({ page }) => {
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "rss",
      target: rail("订阅"),
      settle: 1500,
      hold: 0.8,
    },
    { label: "all", target: 'button:has-text("全部")', frame: RSS_FRAME, hold: 0.8 },
    { label: "unread", target: 'button:has-text("未读")', frame: RSS_FRAME, hold: 0.8 },
    {
      label: "translate",
      target: '[aria-label="译文"]',
      frame: RSS_FRAME,
      settle: 1500,
      hold: 1.0,
    },
    {
      label: "select",
      target: "article[data-stream-item] .text p",
      frame: RSS_FRAME,
      clicks: 3,
      hold: 0.8,
    },
    { label: "quote", target: ".pick", frame: RSS_FRAME, hold: 1.4 },
    {
      label: "needs-you-again",
      target: rail("Needs you"),
      hold: 1.0,
    },
    {
      label: "open-approval",
      target: `${needsYouRow("Archive the newsletters")} >> text=打开线程`,
      settle: 1200,
      hold: 0.8,
    },
    {
      label: "mail",
      target: rail("邮箱"),
      settle: 1500,
      hold: 1.2,
      after: async ({ page }) => {
        await page.frameLocator(MAIL_FRAME).locator("text=Frontend Weekly").first().waitFor();
      },
    },
    {
      label: "approve",
      target: 'button:has-text("Approve")',
      settle: 1500,
      hold: 1.2,
      after: async ({ mail }) => {
        await mail?.move("7:10", "Archive");
      },
    },
    {
      label: "refresh",
      target: '[aria-label="刷新"]',
      frame: MAIL_FRAME,
      hold: 1.2,
      after: async ({ page }) => {
        await page
          .frameLocator(MAIL_FRAME)
          .locator("text=Frontend Weekly")
          .first()
          .waitFor({ state: "detached" });
      },
    },
    {
      label: "git",
      target: '[aria-label="Git"]',
      settle: 2000,
      hold: 1.2,
    },
    {
      label: "commit",
      target: '[role="listbox"][aria-label="提交"] [role="option"]:has-text("payment form")',
      settle: 1500,
      hold: 1.2,
    },
    {
      label: "diff",
      target: '[role="listbox"][aria-label="提交的文件"] [role="option"]',
      settle: 1500,
      hold: 1.6,
    },
  ],
};

export const STORIES: Record<string, Story> = {
  rail: {
    plugins: [rssPlugin, mailPlugin],
    rail: [
      { _tag: "builtin", id: "needsYou" },
      { _tag: "builtin", id: "browser" },
      { _tag: "builtin", id: "terminal" },
      { _tag: "builtin", id: "files" },
      { _tag: "builtin", id: "diff" },
      { _tag: "plugin", pluginId: "t3-rss", viewId: "panel", title: "订阅" },
      { _tag: "plugin", pluginId: "t3-mail", viewId: "mailbox", title: "邮箱" },
    ],
    pluginData: rssDemoData,
    projects: [
      {
        name: "acme-dashboard",
        files: acme,
        threads: [
          {
            key: "main",
            title: "Add a clamp helper",
            model: "showcase",
            messages: ["Add a clamp helper next to sum and run the tests"],
          },
          {
            key: "plan",
            title: "Plan the billing page refactor",
            model: "todo-list",
            messages: ["Plan the billing page refactor"],
          },
          {
            key: "flaky",
            title: "Why is the login test flaky?",
            model: "multi-turn",
            messages: ["Why is the login test flaky?", "Fix it"],
          },
        ],
      },
      {
        name: "pocket-notes",
        files: { "README.md": "# Pocket Notes\n\nOffline-first notes.\n" },
        threads: [
          {
            key: "sync",
            title: "Ship offline sync",
            model: "command-output",
            messages: ["Run the sync test suite"],
          },
        ],
      },
    ],
    open: "main",
    steps: [
      { label: "overview", hold: 2 },
      { label: "files", target: rail("Files"), zoom: { x: 760, y: 0, w: 680 } },
      { label: "rss", target: rail("订阅"), settle: 2500, zoom: { x: 760, y: 0, w: 680 } },
      { label: "add-apps", target: '[aria-label="Add apps"]', zoom: { x: 515, y: 360, w: 925 } },
      { label: "end", key: "Escape", hold: 2 },
    ],
  },
  plugins,
};
