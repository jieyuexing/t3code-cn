// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - 剧本在录制前同步读本机插件缓存，并按当下时间标记缓存新鲜度。
// 展示剧本：演示 home 里装哪些插件、放哪些项目与线程、按什么顺序点哪里。
import * as NodeChildProcess from "node:child_process";
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

/** 插件在总仓里的位置按登记 id 取（`host/bin/universe path`），目录布局变了不用改这里。 */
function universePlugin(id: string): string {
  for (let dir = import.meta.dirname; dir !== NodePath.dirname(dir); dir = NodePath.dirname(dir)) {
    if (!NodeFS.existsSync(NodePath.join(dir, "host/config/workspaces.json"))) continue;
    const cli = NodePath.join(dir, "host/bin/universe");
    return NodeChildProcess.execFileSync(cli, ["path", id], { encoding: "utf8" }).trim();
  }
  throw new Error(`找不到总仓根，无法定位插件 ${id}；请在总仓里的 t3code-cn 检出运行`);
}
const rssPlugin = universePlugin("t3-rss-plugin");
export const mailPlugin = universePlugin("t3-mail-plugin");

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

const demoProjects: Story["projects"] = [
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
];

const BUILTIN_RAIL = [{ _tag: "builtin", id: "files" }] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// start-app.ts 固定注入 T3CODE_ENVIRONMENT_LABEL=Scenario；录制上游讨论配图时在浏览器内统一替为 MacBook Pro 并关掉无关 fork 栏。
async function prepareUpstreamDiscussionPage(
  page: Page,
  options: { readonly hideRefiner?: boolean } = {},
) {
  await page.evaluate(
    async ({ hideRefiner }) => {
      const scrub = (root: Node) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue?.includes("Scenario")) {
            node.nodeValue = node.nodeValue.replaceAll("Scenario", "MacBook Pro");
          }
        }
      };
      scrub(document.body);
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") scrub(record.target.parentNode ?? record.target);
          for (const added of record.addedNodes) scrub(added);
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });

      if (hideRefiner !== false && !document.getElementById("hide-refiner-wand")) {
        const style = document.createElement("style");
        style.id = "hide-refiner-wand";
        style.textContent = '[aria-label^="优化提示词"]{display:none!important}';
        document.head.appendChild(style);
      }

      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          get: (atom: unknown) => unknown;
        };
      };
      const { runAtomCommand } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/runtime.ts",
      )) as {
        runAtomCommand: (
          registry: unknown,
          command: unknown,
          input: unknown,
          options?: unknown,
        ) => Promise<unknown>;
      };
      const { pluginHostEnvironment } = (await load("/src/pluginHost/state.ts")) as {
        pluginHostEnvironment: { call: unknown };
      };
      const [, environmentId = ""] = window.location.pathname.split("/");
      await runAtomCommand(
        appAtomRegistry,
        pluginHostEnvironment.call,
        {
          environmentId,
          input: { _tag: "setRail", rail: { enabled: false, items: [] } },
        },
        { reportFailure: false },
      );
    },
    { hideRefiner: options.hideRefiner ?? true },
  );
  await page.locator('[aria-label="App rail"]').waitFor({ state: "detached", timeout: 10_000 });
  await sleep(500);
}

async function spaNavigate(page: Page, toPath: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, toPath);
  await sleep(800);
}

const discussion41387: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.route("**/api/cn/prompt-refine*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          refined:
            "Inspect `server/src/metrics.ts` and `server/src/math.ts` in `acme-dashboard` for empty or non-positive window inputs:\n1. Check how `window(n)` behaves when `0`, negative values, or `NaN` are passed.\n2. Reuse `clamp` so invalid window bounds fall back cleanly without throwing.\n3. Add unit tests in `server/src/math.test.ts` covering `window(0)` and negative inputs.",
          mode: "structured",
          usedWorkspaceContext: true,
        }),
      });
    });
    const editor = page.locator('[data-chat-composer-form] [contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.insertText("check why metrics window can fail on empty input and fix it");
    await page.mouse.move(648, 30);
    await sleep(600);
  },
  steps: [
    { label: "before-composer", hold: 1.4 },
    {
      label: "after-preview",
      hold: 1.6,
      after: async ({ page }) => {
        await page.evaluate(() => document.getElementById("hide-refiner-wand")?.remove());
        const wand = page.locator('[aria-label^="优化提示词"]').first();
        await wand.waitFor({ timeout: 10_000 });
        await wand.click();
        await page.locator('[data-testid="prompt-refiner-result"]').waitFor({ timeout: 10_000 });
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "after-applied",
      target: '[data-prompt-refiner-card="true"] button:has-text("应用替换")',
      settle: 1000,
      hold: 1.6,
      after: async ({ page }) => {
        await page.locator('button:has-text("撤销优化")').waitFor({ timeout: 10_000 });
        await page.mouse.move(648, 30);
      },
    },
  ],
};

const discussion41360: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.evaluate(async () => {
      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          get: (atom: unknown) => unknown;
          set: (atom: unknown, val: unknown) => void;
          ensureNode: (atom: unknown) => { setValue: (val: unknown) => void };
        };
      };
      const { serverUpdateStateAtom } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/server.ts",
      )) as {
        serverUpdateStateAtom: (key: string) => unknown;
      };
      const { serverEnvironment } = (await load("/src/state/server.ts")) as {
        serverEnvironment: {
          configProjection: (target: {
            environmentId: string;
            input: Record<string, never>;
          }) => unknown;
        };
      };
      const { orchestrationEnvironment } = (await load("/src/state/orchestration.ts")) as {
        orchestrationEnvironment: {
          v2: {
            promptSuggestion: (target: {
              environmentId: string;
              input: { threadId: string };
            }) => unknown;
          };
        };
      };
      const { readThreadShell } = (await load("/src/state/entities.ts")) as {
        readThreadShell: (ref: {
          environmentId: string;
          threadId: string;
        }) => { latestRun?: { runId: string } | null } | null;
      };
      const [, environmentId = "", threadId = ""] = window.location.pathname.split("/");
      const configAtom = serverEnvironment.configProjection({ environmentId, input: {} });
      const currentConfig = appAtomRegistry.get(configAtom) as {
        _tag: string;
        value?: {
          config?: { settings?: Record<string, unknown> };
        };
      };
      if (currentConfig._tag === "Success" && currentConfig.value?.config) {
        appAtomRegistry.ensureNode(configAtom).setValue({
          ...currentConfig,
          value: {
            ...currentConfig.value,
            config: {
              ...currentConfig.value.config,
              settings: {
                ...currentConfig.value.config.settings,
                promptSuggestionsEnabled: true,
              },
            },
          },
        });
      }
      const shell = readThreadShell({ environmentId, threadId });
      const runId = shell?.latestRun?.runId ?? "";
      const suggestionAtom = serverUpdateStateAtom("__synthetic_prompt_suggestion__") as {
        keepAlive?: boolean;
      };
      suggestionAtom.keepAlive = true;
      (appAtomRegistry as unknown as { mount: (a: unknown) => void }).mount(suggestionAtom);
      (
        window as unknown as {
          __demoRunId?: string;
          __demoSuggestionAtom?: unknown;
        }
      ).__demoRunId = runId;
      (
        window as unknown as {
          __demoSuggestionAtom?: unknown;
        }
      ).__demoSuggestionAtom = suggestionAtom;
      orchestrationEnvironment.v2.promptSuggestion = () => suggestionAtom;
      appAtomRegistry.set(suggestionAtom, {
        _tag: "Success",
        value: { runId, text: "Looks good, commit and push the changes" },
        waiting: false,
        timestamp: Date.now(),
      });
    });
    await page.locator('[aria-label="Use suggested prompt"]').waitFor({ timeout: 10_000 });
    await page.mouse.move(648, 30);
    await sleep(500);
  },
  steps: [
    { label: "before-ghost-text", hold: 1.4 },
    {
      label: "after-advisor-strip",
      hold: 1.6,
      after: async ({ page }) => {
        await page.evaluate(async () => {
          const load = new Function("p", "return import(p)") as (
            path: string,
          ) => Promise<Record<string, unknown>>;
          const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
            appAtomRegistry: {
              set: (atom: unknown, val: unknown) => void;
            };
          };
          const win = window as unknown as {
            __demoRunId?: string;
            __demoSuggestionAtom?: unknown;
          };
          const runId = win.__demoRunId ?? "";
          const payload =
            "\u001et3cn-advisor:v1:" +
            JSON.stringify({
              items: [
                {
                  kind: "challenge",
                  label: "检查 min > max 边界",
                  fill: "如果调用 clamp(x, min, max) 时传入 min > max 或 NaN，当前实现不会报错，是否需要补充参数断言？",
                },
                {
                  kind: "next",
                  label: "补齐 math.test.ts 边界用例",
                  fill: "在 server/src/math.test.ts 中补充负数、零长区间（min === max）与极值的单元测试并运行验证。",
                },
                {
                  kind: "angle",
                  label: "排查 metrics.ts 复用点",
                  fill: "检查 server/src/metrics.ts 中的窗口计算是否可以直接复用 clamp 替代手写分支。",
                },
              ],
            });
          appAtomRegistry.set(win.__demoSuggestionAtom, {
            _tag: "Success",
            value: { runId, text: payload },
            waiting: false,
            timestamp: Date.now(),
          });
        });
        await page.locator('[data-chat-composer-choices="true"]').waitFor({ timeout: 10_000 });
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "after-advisor-filled",
      target: '[data-chat-composer-choices="true"] button',
      settle: 1000,
      hold: 1.6,
      after: async ({ page }) => {
        await page.mouse.move(648, 30);
      },
    },
  ],
};

const discussion41336: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.evaluate(async () => {
      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          set: (atom: unknown, val: unknown) => void;
        };
      };
      const { serverUpdateStateAtom } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/server.ts",
      )) as {
        serverUpdateStateAtom: (key: string) => unknown;
      };
      const { serverEnvironment } = (await load("/src/state/server.ts")) as {
        serverEnvironment: Record<string, (target: unknown) => unknown>;
      };
      const { clearEnvironmentMachineHistory, recordEnvironmentMachineSample } = (await load(
        "/node_modules/@t3tools/client-runtime/src/machineResourcesHistory.cn.ts",
      )) as {
        clearEnvironmentMachineHistory: (envId: string) => void;
        recordEnvironmentMachineSample: (envId: string, snap: unknown) => void;
      };
      const [, environmentId = ""] = window.location.pathname.split("/");
      const GiB = 1024 ** 3;
      const MiB = 1024 ** 2;
      const now = Date.now();
      const makeSnapshot = (
        at: number,
        cpu: number,
        memUsedGiB: number,
        rxMiB: number,
        txKiB: number,
      ) => ({
        sampledAt: at,
        cpuUtilization: cpu,
        cpuCount: 8,
        cpuModel: "Apple M3 Pro",
        loadAverage: { one: 2.84, five: 2.41, fifteen: 1.96 },
        availableMemoryBytes: Math.round((64 - memUsedGiB) * GiB),
        totalMemoryBytes: 64 * GiB,
        swap: { usedBytes: 0, totalBytes: 8 * GiB },
        cpuCores: [
          { utilization: 0.62, user: 0.48, system: 0.14 },
          { utilization: 0.54, user: 0.41, system: 0.13 },
          { utilization: 0.45, user: 0.35, system: 0.1 },
          { utilization: 0.38, user: 0.29, system: 0.09 },
          { utilization: 0.33, user: 0.25, system: 0.08 },
          { utilization: 0.28, user: 0.21, system: 0.07 },
          { utilization: 0.22, user: 0.17, system: 0.05 },
          { utilization: 0.18, user: 0.14, system: 0.04 },
        ],
        memoryBreakdown: {
          kind: "darwin",
          appBytes: Math.round(24.8 * GiB),
          wiredBytes: Math.round(7.4 * GiB),
          compressedBytes: Math.round(6.2 * GiB),
          availableBytes: Math.round((64 - memUsedGiB) * GiB),
        },
        memoryPressure: { level: "normal" },
        network: {
          sampledAt: at,
          warmingUp: false,
          downloadBytesPerSecond: Math.round(rxMiB * MiB),
          uploadBytesPerSecond: Math.round(txKiB * 1024),
          totalReceivedBytes: Math.round(4.2 * GiB),
          totalTransmittedBytes: Math.round(1.1 * GiB),
        },
        storage: {
          sampledAt: at,
          volumes: [
            {
              mountPoint: "/",
              name: "Macintosh HD",
              fileSystem: "apfs",
              totalBytes: 1000 * GiB,
              availableBytes: 412 * GiB,
              isReadOnly: false,
              roles: ["system", "t3Home"],
            },
          ],
        },
        gpus: [
          {
            name: "Apple M3 Pro GPU",
            vendor: "Apple",
            coreCount: 18,
            utilization: 0.19,
          },
        ],
      });

      const seedHistory = () => {
        clearEnvironmentMachineHistory(environmentId);
        const series = [
          [0.22, 34.8, 0.7, 190],
          [0.26, 35.1, 0.9, 210],
          [0.31, 35.5, 1.2, 240],
          [0.28, 35.4, 1.0, 220],
          [0.36, 36.1, 1.5, 290],
          [0.44, 37.0, 2.0, 380],
          [0.51, 37.8, 2.6, 460],
          [0.47, 37.6, 2.2, 410],
          [0.39, 37.2, 1.6, 330],
          [0.34, 36.9, 1.3, 280],
          [0.41, 37.5, 1.8, 360],
          [0.53, 38.5, 2.8, 510],
          [0.58, 39.2, 3.3, 620],
          [0.49, 38.9, 2.5, 480],
          [0.43, 38.6, 1.9, 390],
          [0.38, 38.2, 1.5, 340],
          [0.45, 38.5, 2.1, 440],
          [0.42, 38.4, 1.8, 420],
        ] as const;
        for (const [idx, [cpu, mem, rx, tx]] of series.entries()) {
          const at = now - (series.length - 1 - idx) * 45_000;
          recordEnvironmentMachineSample(environmentId, makeSnapshot(at, cpu, mem, rx, tx));
        }
      };
      seedHistory();
      (window as unknown as { __seedMachineHistory?: () => void }).__seedMachineHistory =
        seedHistory;

      const latest = makeSnapshot(now, 0.42, 38.4, 1.8, 420);
      const machineAtom = serverUpdateStateAtom("__synthetic_machine_resources__") as {
        keepAlive?: boolean;
      };
      machineAtom.keepAlive = true;
      (appAtomRegistry as unknown as { mount: (a: unknown) => void }).mount(machineAtom);
      appAtomRegistry.set(machineAtom, {
        _tag: "Success",
        value: latest,
        waiting: false,
        timestamp: now,
      });
      serverEnvironment.machineResources = () => machineAtom;
      serverEnvironment.hostResources = () => machineAtom;
    });
    await spaNavigate(page, "/settings/connections");
    await page.locator('[role="switch"][aria-label="Show load"]').waitFor({ timeout: 15_000 });
    await page.mouse.move(648, 30);
    await sleep(600);
  },
  steps: [
    { label: "before-map", hold: 1.4 },
    {
      label: "after-map-load",
      target: '[role="switch"][aria-label="Show load"]',
      settle: 1000,
      hold: 1.6,
      after: async ({ page }) => {
        await page.locator("text=CPU 42%").first().waitFor({ timeout: 10_000 });
        const macNode = page.locator("button:has-text('MacBook Pro')").first();
        if (await macNode.isVisible().catch(() => false)) {
          await macNode.click();
          await sleep(500);
        }
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "after-diagnostics-machine",
      hold: 1.6,
      after: async ({ page }) => {
        await spaNavigate(page, "/settings/diagnostics");
        const cpuTab = page.getByRole("tab", { name: "CPU & Memory" });
        await cpuTab.waitFor({ timeout: 15_000 });
        await sleep(300);
        await page.evaluate(() => {
          (window as unknown as { __seedMachineHistory?: () => void }).__seedMachineHistory?.();
        });
        await cpuTab.click();
        await sleep(600);
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "after-devices-headroom",
      hold: 1.6,
      after: async ({ page }) => {
        await spaNavigate(page, "/settings/devices");
        await page
          .locator('[data-slot="device-host-headroom"]')
          .first()
          .waitFor({ timeout: 15_000 });
        await page.mouse.move(648, 30);
      },
    },
  ],
};

const discussion41273: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.evaluate(async () => {
      const style = document.createElement("style");
      style.id = "hide-fork-speed-tab";
      style.textContent =
        '[aria-label="Usage metric"] button[value="speed"]{display:none!important}';
      document.head.appendChild(style);

      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          get: (atom: unknown) => unknown;
          set: (atom: unknown, val: unknown) => void;
        };
      };
      const { serverUpdateStateAtom } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/server.ts",
      )) as {
        serverUpdateStateAtom: (key: string) => unknown;
      };
      const { environmentPresentations } = (await load("/src/state/presentation.ts")) as {
        environmentPresentations: {
          presentationsWithProvidersAtom: unknown;
        };
      };
      const [, environmentId = ""] = window.location.pathname.split("/");
      const now = Date.now();
      const checkedAt = new Date(now).toISOString();
      const day1WeeklyReset = new Date(now + 9945 * 60_000).toISOString();
      const sessionReset = new Date(now + 220 * 60_000).toISOString();
      const day4WeeklyReset = new Date(now + 5040 * 60_000).toISOString();

      const currentMap = appAtomRegistry.get(
        environmentPresentations.presentationsWithProvidersAtom,
      ) as ReadonlyMap<string, Record<string, unknown>>;
      const existing = currentMap.get(environmentId) ?? {};
      const existingConfig = (existing.serverConfig as Record<string, unknown> | null) ?? {};
      const syntheticProviders = [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude Code",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated", label: "Max" },
          checkedAt,
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "5-hour session",
                usedPercent: 26,
                resetsAt: sessionReset,
                windowDurationMins: 300,
              },
              {
                id: "seven_day",
                kind: "weekly",
                label: "7-day weekly (All models)",
                usedPercent: 12,
                resetsAt: day1WeeklyReset,
                windowDurationMins: 10080,
              },
              {
                id: "seven_day_sonnet",
                kind: "weekly",
                label: "7-day weekly (Sonnet)",
                usedPercent: 8,
                resetsAt: day1WeeklyReset,
                windowDurationMins: 10080,
              },
            ],
          },
        },
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated", label: "ChatGPT Plus Subscription" },
          checkedAt,
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "primary",
                kind: "session",
                label: "5-hour session",
                usedPercent: 18,
                resetsAt: sessionReset,
                windowDurationMins: 300,
              },
              {
                id: "secondary",
                kind: "weekly",
                label: "7-day weekly",
                usedPercent: 48,
                resetsAt: day4WeeklyReset,
                windowDurationMins: 10080,
              },
            ],
          },
        },
      ];
      const nextMap = new Map(currentMap);
      nextMap.set(environmentId, {
        ...existing,
        entry: {
          ...(existing.entry as Record<string, unknown>),
          target: {
            ...(existing.entry as { target?: Record<string, unknown> })?.target,
            label: "MacBook Pro",
          },
        },
        serverConfig: {
          ...existingConfig,
          providers: syntheticProviders,
        },
      });
      const presAtom = serverUpdateStateAtom("__synthetic_presentations_with_providers__") as {
        keepAlive?: boolean;
      };
      presAtom.keepAlive = true;
      (appAtomRegistry as unknown as { mount: (a: unknown) => void }).mount(presAtom);
      appAtomRegistry.set(presAtom, nextMap);
      environmentPresentations.presentationsWithProvidersAtom = presAtom;
    });
    await spaNavigate(page, "/usage");
    const limitsBtn = page.locator('button:has-text("Limits")').first();
    await limitsBtn.waitFor({ timeout: 15_000 });
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll("button")) {
        if (btn.textContent?.trim() === "Speed") {
          (btn as HTMLElement).style.display = "none";
        }
      }
    });
    await limitsBtn.click();
    await page.locator("text=7-day weekly (All models)").first().waitFor({ timeout: 10_000 });
    const bar = page.locator('[aria-label*="88% left"]').first();
    await bar.hover();
    await page.locator("text=99% left by now").first().waitFor({ timeout: 10_000 });
    await sleep(600);
  },
  steps: [
    { label: "current-day1-weekly-pace", hold: 1.5 },
    {
      label: "current-day1-weekly-pace-annotated",
      hold: 1.8,
      after: async ({ page }) => {
        await page.evaluate(() => {
          const banner = document.createElement("div");
          banner.id = "pace-issue-annotation";
          banner.style.cssText =
            "position:fixed;right:48px;bottom:48px;z-index:9999;max-width:460px;border:2px solid #dc2626;border-radius:12px;background:#fef2f2;color:#7f1d1d;padding:14px 16px;font-size:12.5px;line-height:1.5;box-shadow:0 12px 28px rgba(0,0,0,0.14);";
          banner.innerHTML =
            '<div style="font-weight:700;margin-bottom:4px;color:#991b1b;">Current Day-1 weekly linear pace behavior (#41273)</div>' +
            "<div>1. <b>2h into a 7d window (6d 21h left)</b>: linear target is <b>99% left by now</b>, clamping the tick to <code>calc(100% - 3px)</code> at the right edge.</div>" +
            "<div>2. <b>12% Day-1 usage (88% left)</b> immediately triggers <b>Ahead of pace (↗)</b> because <code>usedPercent - elapsed*100 &gt; 5</code>.</div>";
          document.body.appendChild(banner);
        });
        const bar = page.locator('[aria-label*="88% left"]').first();
        await bar.hover();
        await sleep(500);
      },
    },
  ],
};

const discussion40789: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.evaluate(async () => {
      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          set: (atom: unknown, val: unknown) => void;
          mount: (atom: unknown) => void;
        };
      };
      const { runAtomCommand } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/runtime.ts",
      )) as {
        runAtomCommand: (
          registry: unknown,
          command: unknown,
          input: unknown,
          options?: unknown,
        ) => Promise<unknown>;
      };
      const {
        BearerConnectionCredential,
        BearerConnectionProfile,
        BearerConnectionRegistration,
        BearerConnectionTarget,
      } = (await load("/node_modules/@t3tools/client-runtime/src/connection/index.ts")) as {
        BearerConnectionCredential: new (args: unknown) => unknown;
        BearerConnectionProfile: new (args: unknown) => unknown;
        BearerConnectionRegistration: new (args: unknown) => unknown;
        BearerConnectionTarget: new (args: unknown) => unknown;
      };
      const { serverUpdateStateAtom } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/server.ts",
      )) as {
        serverUpdateStateAtom: (key: string) => { keepAlive?: boolean };
      };
      const { environmentCatalog } = (await load("/src/connection/catalog.ts")) as {
        environmentCatalog: {
          register: unknown;
          stateAtom: (envId: string) => unknown;
        };
      };

      const secondaryId = "env-studio-workstation";
      const url = "https://workstation.tailnet.example:8443";
      const wsUrl = "wss://workstation.tailnet.example:8443";
      const now = Date.now();
      const backoffState = {
        phase: "backoff",
        network: "online",
        attempt: 214,
        retryAt: now + 245_000,
        refusedRouteIds: [],
        lastFailure: {
          _tag: "ConnectionTransientError",
          environmentId: secondaryId,
          reason: "timeout",
          hop: "server",
          failureCause: "timeout",
          via: "direct",
          routeLabel: url,
          message: "Connection timed out after 10000ms",
        },
      };

      const secondaryStateAtom = serverUpdateStateAtom("__synthetic_secondary_state__");
      secondaryStateAtom.keepAlive = true;
      appAtomRegistry.mount(secondaryStateAtom);
      appAtomRegistry.set(secondaryStateAtom, {
        _tag: "Success",
        value: backoffState,
        waiting: false,
        timestamp: now,
      });
      const origStateAtom = environmentCatalog.stateAtom;
      environmentCatalog.stateAtom = (id: string) =>
        id === secondaryId ? secondaryStateAtom : origStateAtom(id);

      await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.register,
        new BearerConnectionRegistration({
          target: new BearerConnectionTarget({
            connectionId: "saved:studio-workstation",
            environmentId: secondaryId,
            label: "Studio Workstation",
          }),
          profile: new BearerConnectionProfile({
            connectionId: "saved:studio-workstation",
            environmentId: secondaryId,
            label: "Studio Workstation",
            httpBaseUrl: url,
            wsBaseUrl: wsUrl,
          }),
          credential: new BearerConnectionCredential({ token: "demo-token" }),
        }),
        { reportFailure: false },
      );
    });
    await spaNavigate(page, "/settings/connections");
    const listToggle = page
      .locator('[aria-label="Show environments as"] button:has-text("List")')
      .first();
    await listToggle.waitFor({ timeout: 15_000 });
    await listToggle.click();
    await page.locator("text=Studio Workstation").first().waitFor({ timeout: 10_000 });
    await page.locator("text=attempt 214").first().waitFor({ timeout: 10_000 });
    await page.mouse.move(648, 30);
    await sleep(500);
  },
  steps: [
    { label: "current-overnight-backoff", hold: 1.5 },
    {
      label: "current-overnight-backoff-details",
      target: 'button:has-text("Details")',
      settle: 1000,
      hold: 1.8,
      after: async ({ page }) => {
        await page.evaluate(() => {
          const banner = document.createElement("div");
          banner.id = "backoff-issue-annotation";
          banner.style.cssText =
            "position:fixed;right:48px;bottom:48px;z-index:9999;max-width:460px;border:2px solid #dc2626;border-radius:12px;background:#fef2f2;color:#7f1d1d;padding:14px 16px;font-size:12.5px;line-height:1.5;box-shadow:0 12px 28px rgba(0,0,0,0.14);";
          banner.innerHTML =
            '<div style="font-weight:700;margin-bottom:4px;color:#991b1b;">Current 5-minute backoff ceiling (#40789)</div>' +
            "<div>• <code>RETRY_MAX_DELAY_MS = 300_000</code> (5m) applies indefinitely to every enabled environment.</div>" +
            "<div>• An offline secondary machine generates <b>~200+ failed retries</b> overnight (<code>attempt 214</code>) unless manually toggled off daily.</div>";
          document.body.appendChild(banner);
        });
        await page.mouse.move(648, 30);
      },
    },
  ],
};

const discussion40786: Story = {
  plugins: [],
  rail: BUILTIN_RAIL,
  pluginData: () => ({}),
  projects: demoProjects,
  open: "main",
  prepare: async ({ page }) => {
    await prepareUpstreamDiscussionPage(page, { hideRefiner: true });
    await page.evaluate(async () => {
      const load = new Function("p", "return import(p)") as (
        path: string,
      ) => Promise<Record<string, unknown>>;
      const { persistGTLocale, whenLocaleReady } = (await load("/src/i18n/runtime.ts")) as {
        persistGTLocale: (locale: string) => void;
        whenLocaleReady: () => Promise<void>;
      };
      persistGTLocale("zh");
      await whenLocaleReady();

      const { appAtomRegistry } = (await load("/src/rpc/atomRegistry.ts")) as {
        appAtomRegistry: {
          get: (atom: unknown) => unknown;
        };
      };
      const { runAtomCommand } = (await load(
        "/node_modules/@t3tools/client-runtime/src/state/runtime.ts",
      )) as {
        runAtomCommand: (
          registry: unknown,
          command: unknown,
          input: unknown,
          options?: unknown,
        ) => Promise<unknown>;
      };
      const { environmentThreadShells, threadEnvironment } = (await load(
        "/src/state/threads.ts",
      )) as {
        environmentThreadShells: {
          environmentThreadsAtom: (envId: string) => unknown;
        };
        threadEnvironment: {
          settle: unknown;
          snooze: unknown;
        };
      };
      const [, environmentId = ""] = window.location.pathname.split("/");
      const threads = appAtomRegistry.get(
        environmentThreadShells.environmentThreadsAtom(environmentId),
      ) as ReadonlyArray<{ id: string; title: string }>;
      const syncThread = threads.find((t) => t.title.includes("Ship offline sync"));
      const flakyThread = threads.find((t) => t.title.includes("Why is the login test flaky"));
      if (syncThread) {
        await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.settle,
          { environmentId, input: { threadId: syncThread.id } },
          { reportFailure: false },
        );
      }
      if (flakyThread) {
        const snoozedUntil = new Date(Date.now() + 2 * 3600_000).toISOString();
        await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.snooze,
          { environmentId, input: { threadId: flakyThread.id, snoozedUntil } },
          { reportFailure: false },
        );
      }
    });
    await sleep(1000);
    const snoozedBtn = page.locator("button:has-text('已暂缓')").first();
    if (await snoozedBtn.isVisible().catch(() => false)) {
      await snoozedBtn.click();
    }
    const settledBtn = page.locator("button:has-text('已收尾')").first();
    if (await settledBtn.isVisible().catch(() => false)) {
      await settledBtn.click();
    }
    await sleep(400);
    await page
      .locator('[data-thread-item]:has-text("Plan the billing page refactor")')
      .first()
      .click({ button: "right" });
    await sleep(600);
  },
  steps: [
    { label: "before-sidebar-zh", hold: 1.5 },
    {
      label: "before-settings-zh",
      hold: 1.6,
      after: async ({ page }) => {
        await page.keyboard.press("Escape");
        await sleep(200);
        await spaNavigate(page, "/settings/threads");
        const target = page.locator("text=自动收尾不活跃会话").first();
        await target.waitFor({ timeout: 10_000 });
        await target.evaluate((el) => {
          el.scrollIntoView({ block: "center" });
        });
        await sleep(500);
        await page.mouse.move(648, 30);
      },
    },
    {
      label: "after-sidebar-zh",
      hold: 1.6,
      after: async ({ page }) => {
        await page.evaluate(async () => {
          const load = new Function("p", "return import(p)") as (
            path: string,
          ) => Promise<Record<string, unknown>>;
          const { getI18nSnapshot, persistGTLocale, whenLocaleReady } = (await load(
            "/src/i18n/runtime.ts",
          )) as {
            getI18nSnapshot: () => { translations: Record<string, Record<string, unknown>> };
            persistGTLocale: (locale: string) => void;
            whenLocaleReady: () => Promise<void>;
          };
          const zh = getI18nSnapshot().translations.zh;
          if (zh) {
            const replacements: Record<string, string> = {
              已暂缓: "稍后处理",
              暂缓: "延后",
              暂缓会话: "延后",
              取消暂缓: "取消延后",
              暂缓选项: "延后选项",
              暂缓到: "延后到",
              暂缓到用量限制重置: "延后到用量限制重置",
              "将会话暂缓到用量限制重置。开启自动继续后，智能体会在重置后接着工作。":
                "将会话延后到用量限制重置。开启自动继续后，智能体会在重置后接着工作。",
              "所有暂缓菜单的选项，按时间从近到远排列。星期表示今天之后的下一个对应日期。":
                "所有延后菜单的选项，按时间从近到远排列。星期表示今天之后的下一个对应日期。",
              已收尾: "已处理",
              收尾: "标为已处理",
              收尾会话: "标为已处理",
              取消收尾: "取消已处理",
              取消会话收尾: "取消已处理",
              自动收尾: "自动标为已处理",
              自动收尾行为: "自动标为已处理",
              自动收尾不活跃会话: "自动将不活跃会话标为已处理",
              合并后自动收尾会话: "自动将已合并会话标为已处理",
              自动收尾已合并会话: "自动将已合并会话标为已处理",
              自动收尾前的闲置天数: "自动标为已处理前的天数",
              自动收尾前的天数: "自动标为已处理前的天数",
              "Pull request 合并后收尾会话。已关闭的 pull request 仍会自动收尾。":
                "Pull request 合并后将会话标为已处理。已关闭的 pull request 仍会自动标为已处理。",
              "侧边栏中闲置达到此时长的会话会自动收尾。":
                "侧边栏中闲置达到此时长的会话会自动标为已处理。",
              "会话有新活动时会自动取消收尾。": "会话有新活动时会自动取消已处理。",
              "闲置不会让有 pull request 的会话收尾，但合并和关闭仍会。":
                "闲置不会让有 pull request 的会话标为已处理，但合并和关闭仍会。",
            };
            for (const [k, v] of Object.entries(zh)) {
              if (typeof v !== "string") continue;
              if (replacements[v]) {
                zh[k] = replacements[v];
              } else if (v.includes("已暂缓，剩余")) {
                zh[k] = v.replace("已暂缓，剩余", "已延后，剩余");
              }
            }
          }
          persistGTLocale("en");
          await whenLocaleReady();
          persistGTLocale("zh");
          await whenLocaleReady();
        });
        const closeBtn = page
          .locator('[aria-label="关闭设置"], [aria-label="Close settings"]')
          .first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click();
        } else {
          await page.keyboard.press("Escape");
        }
        await sleep(500);
        await page
          .locator('[data-thread-item]:has-text("Plan the billing page refactor")')
          .first()
          .click({ button: "right" });
        await sleep(600);
      },
    },
    {
      label: "after-settings-zh",
      hold: 1.6,
      after: async ({ page }) => {
        await page.keyboard.press("Escape");
        await sleep(200);
        await spaNavigate(page, "/settings/threads");
        const target = page.locator("text=自动将不活跃会话标为已处理").first();
        await target.waitFor({ timeout: 10_000 });
        await target.evaluate((el) => {
          el.scrollIntoView({ block: "center" });
        });
        await sleep(500);
        await page.mouse.move(648, 30);
      },
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
    projects: demoProjects,
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
  "discussion-41387": discussion41387,
  "discussion-41360": discussion41360,
  "discussion-41336": discussion41336,
  "discussion-41273": discussion41273,
  "discussion-40789": discussion40789,
  "discussion-40786": discussion40786,
};
