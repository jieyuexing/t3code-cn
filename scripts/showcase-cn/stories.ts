// @effect-diagnostics nodeBuiltinImport:off - 剧本在录制前同步读本机插件缓存。
// 展示剧本：演示 home 里装哪些插件、放哪些项目与线程、按什么顺序点哪里。
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface Step {
  readonly label: string;
  /** CSS 选择器；合成时光标移到它的中心，默认还会点它。 */
  readonly target?: string;
  readonly click?: false;
  readonly key?: string;
  /** 这一拍镜头框住的区域（CSS 像素，按 16:9 补齐），缺省为整屏。 */
  readonly zoom?: { readonly x: number; readonly y: number; readonly w: number };
  readonly settle?: number;
  readonly hold?: number;
}

interface Story {
  readonly plugins: ReadonlyArray<string>;
  readonly rail: ReadonlyArray<unknown>;
  readonly pluginData: () => Record<string, unknown>;
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly files: Record<string, string>;
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
const gitStatusPlugin = NodePath.resolve(
  import.meta.dirname,
  "../../plugin-host-examples/git-status",
);

/** 只取公开技术源的本机缓存，订阅列表里的其他源不进演示。 */
const PUBLIC_FEEDS = ["martinfowler.com", "vercel.com", "atlasnote.ai"];
function rssDemoData() {
  const live = NodePath.join(NodeOS.homedir(), ".t3/userdata/plugins/data/t3-rss.json");
  if (!NodeFS.existsSync(live)) return {};
  const { storage } = JSON.parse(NodeFS.readFileSync(live, "utf8"));
  const feeds = (storage.feeds as Array<{ id: string; url: string }>).filter((feed) =>
    PUBLIC_FEEDS.some((host) => feed.url.includes(host)),
  );
  const picked: Record<string, unknown> = { feeds, settings: { translate: false } };
  for (const feed of feeds) picked[`feed.${feed.id}`] = storage[`feed.${feed.id}`];
  return { "t3-rss": { settings: {}, storage: picked } };
}

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

export const STORIES: Record<string, Story> = {
  rail: {
    plugins: [rssPlugin, gitStatusPlugin],
    rail: [
      { _tag: "builtin", id: "needsYou" },
      { _tag: "builtin", id: "browser" },
      { _tag: "builtin", id: "terminal" },
      { _tag: "builtin", id: "files" },
      { _tag: "builtin", id: "diff" },
      { _tag: "plugin", pluginId: "t3-rss", viewId: "panel", title: "订阅" },
      { _tag: "plugin", pluginId: "example.git-status", viewId: "status", title: "Git Status" },
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
};
