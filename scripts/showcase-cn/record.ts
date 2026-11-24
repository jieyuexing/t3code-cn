#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalConsole:off - 宿主侧录制脚本，直接驱动子进程、浏览器与计时。
// 推特展示素材：在隔离的演示 home 里起 dev 栈，按剧本截 2 倍关键帧并记下每步点击的位置。
// 用法：vp run showcase <story> <输出目录> [--dark]，产出 showcase.mp4 与 cover.png。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { chromium, type Page } from "playwright-core";

import { applyHistory } from "./history.ts";
import { startDemoMail, type DemoMail } from "./mail.ts";
import { STORIES, mailPlugin, type Step } from "./stories.ts";

const [storyName = "rail", outDir = "", ...flags] = process.argv.slice(2);
const found = STORIES[storyName];
if (!found || !outDir) {
  console.error(`用法: vp run showcase <${Object.keys(STORIES).join("|")}> <输出目录> [--dark]`);
  process.exit(1);
}
const story = found;
const dark = flags.includes("--dark");
const checkout = NodePath.resolve(import.meta.dirname, "../..");
const home = NodePath.join(checkout, ".t3/showcase");
const seed = NodePath.join(checkout, ".t3/showcase-seed");
// 演示项目放在不含用户名的路径下，回放里出现的绝对路径也就不带个人信息。
const demoRoot = "/Users/Shared/t3-demo";
const VIEWPORT = { width: 1440, height: 900 };

const pluginDigest = (manifestPath: string) => {
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  const ext = manifest.extensions["com.jieyuexing.t3code"];
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        name: manifest.name,
        entry: ext.entry,
        capabilities: [...(ext.capabilities ?? [])].sort(),
        inject: [...(ext.inject ?? [])].sort(),
        provides: (ext.provides ?? []).map((service: { name: string }) => service.name).sort(),
      }),
    )
    .digest("hex");
  return { id: manifest.name as string, digest };
};

function writeSeed(mailPort: number) {
  NodeFS.rmSync(seed, { recursive: true, force: true });
  const plugins = NodePath.join(seed, "userdata/plugins");
  NodeFS.mkdirSync(NodePath.join(plugins, "data"), { recursive: true });
  const registry: Array<{ id: string; path: string; enabled: boolean }> = [];
  const consent: Record<string, string> = {};
  for (const dir of story.plugins) {
    const { id, digest } = pluginDigest(NodePath.join(dir, "plugin.json"));
    registry.push({ id, path: dir, enabled: true });
    consent[id] = digest;
  }
  NodeFS.writeFileSync(
    NodePath.join(plugins, "registry.json"),
    JSON.stringify({ enabled: true, plugins: registry }),
  );
  NodeFS.writeFileSync(NodePath.join(plugins, "consent.json"), JSON.stringify(consent));
  NodeFS.writeFileSync(
    NodePath.join(plugins, "rail.json"),
    JSON.stringify({ enabled: true, items: story.rail }),
  );
  for (const [id, data] of Object.entries(story.pluginData({ mailPort }))) {
    NodeFS.writeFileSync(NodePath.join(plugins, "data", `${id}.json`), JSON.stringify(data));
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(url: string, child: { exitCode: number | null }) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error("dev 栈提前退出，见输出目录下 app.log");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("dev 栈 5 分钟内没就绪");
}

const cli = (args: ReadonlyArray<string>) => {
  try {
    return NodeChildProcess.execFileSync(
      process.execPath,
      ["apps/server/src/bin.ts", ...args, "--base-dir", home],
      {
        cwd: checkout,
        encoding: "utf8",
      },
    );
  } catch (error) {
    // 退出码 2：回合停在等用户回答，演示里正好需要这种状态。
    if ((error as { status?: number }).status === 2) return (error as { stdout: string }).stdout;
    throw error;
  }
};

function seedProjects() {
  NodeFS.rmSync(demoRoot, { recursive: true, force: true });
  const threads: Record<string, string> = {};
  for (const project of story.projects) {
    const dir = NodePath.join(demoRoot, project.name);
    for (const [file, content] of Object.entries(project.files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, file), content);
    }
    const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: dir });
    git("init", "--quiet", "--initial-branch=main");
    if (project.history) {
      applyHistory(dir, project.history);
    } else {
      git("add", "--all");
      git("-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "commit", "-qm", "init");
    }
    cli(["project", "add", dir, "--title", project.name]);
    for (const thread of project.threads) {
      const [first = "Start", ...rest] = thread.messages;
      const replay = ["--provider", "devReplay", "--model", thread.model];
      const started = cli([
        "thread",
        "start",
        dir,
        first,
        "--title",
        thread.title,
        ...replay,
        "--wait",
        "--json",
      ]);
      const { threadId } = JSON.parse(started) as { threadId: string };
      for (const message of rest) cli(["thread", "send", threadId, message, "--wait", "--json"]);
      threads[thread.key] = threadId;
    }
  }
  return threads;
}

const locate = (page: Page, step: Step) =>
  (step.frame ? page.frameLocator(step.frame) : page).locator(step.target!).first();

async function boxOf(page: Page, step: Step) {
  if (!step.target) return null;
  const box = await locate(page, step).boundingBox();
  return box && { x: box.x, y: box.y, w: box.width, h: box.height };
}

async function main() {
  NodeFS.rmSync(outDir, { recursive: true, force: true });
  NodeFS.mkdirSync(outDir, { recursive: true });
  const mailPort = await freePort();
  writeSeed(mailPort);
  const mail: DemoMail | null = story.mailAccountId
    ? await startDemoMail(mailPlugin, mailPort, story.mailAccountId)
    : null;
  const port = await freePort();
  const log = NodeFS.openSync(NodePath.join(outDir, "app.log"), "w");
  const app = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/scenarios/start-app.ts", "web", home, "127.0.0.1", String(port)],
    {
      cwd: checkout,
      env: {
        ...process.env,
        // dev-runner 要用 vp；直接用 node 跑本脚本时它不在 PATH 上。
        PATH: `${NodePath.join(checkout, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
        T3_SCENARIO_HOME_SEED: seed,
      },
      stdio: ["ignore", log, log],
    },
  );
  const stop = () => {
    if (app.exitCode === null) app.kill("SIGTERM");
    mail?.stop();
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(1));
  try {
    const origin = `http://127.0.0.1:${port}`;
    await waitReady(`${origin}/.well-known/t3/environment`, app);
    if (story.supervised) {
      // 默认的完全访问会自动批准回放里的审批请求；演示要让它停在等用户点头。
      const settingsFile = NodePath.join(home, "userdata/settings.json");
      const settings = JSON.parse(NodeFS.readFileSync(settingsFile, "utf8"));
      NodeFS.writeFileSync(
        settingsFile,
        JSON.stringify({ ...settings, defaultRuntimeMode: "approval-required" }),
      );
      await sleep(2000);
    }
    const threads = seedProjects();
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: dark ? "dark" : "light",
    });
    // 机器名不经服务端标签那一处（PATH 垫片管不到）也会进界面，统一在页面里换成通用名。
    const computerName = NodeChildProcess.execFileSync("scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
    }).trim();
    await context.addInitScript((name: string) => {
      const scrub = (root: Node) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeValue?.includes(name))
            node.nodeValue = node.nodeValue.replaceAll(name, "MacBook Pro");
        }
      };
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") scrub(record.target.parentNode ?? record.target);
          for (const added of record.addedNodes) scrub(added);
        }
      }).observe(document, { subtree: true, childList: true, characterData: true });
    }, computerName);
    const page = await context.newPage();
    const credentialFile = NodePath.join(home, "browser-dev-token");
    if (NodeFS.existsSync(credentialFile)) {
      const credential = NodeFS.readFileSync(credentialFile, "utf8").trim();
      const auth = await page.request.post(`${origin}/api/auth/browser-session`, {
        data: { credential },
      });
      if (!auth.ok()) {
        throw new Error(`browser-session sign-in failed: ${auth.status()} ${await auth.text()}`);
      }
    } else {
      await page.goto(origin + NodeFS.readFileSync(NodePath.join(home, "pairing-path"), "utf8"));
      await page.waitForURL((url) => !/\/pair(?:[?#]|$)/.test(url.pathname), { timeout: 60_000 });
    }
    const { environmentId } = (await (
      await fetch(`${origin}/.well-known/t3/environment`)
    ).json()) as { environmentId: string };
    // 配对页登录后会自己跳回首页，可能打断紧接着的跳转；落到会话页、应用栏出现为止。
    const threadUrl = `${origin}/${environmentId}/${threads[story.open]}`;
    for (let attempt = 0; ; attempt++) {
      await page.waitForLoadState("networkidle");
      const landed = await page
        .goto(threadUrl)
        .then(() => page.locator('[aria-label="App rail"]').waitFor({ timeout: 20_000 }))
        .then(
          () => true,
          (error) => (attempt < 3 ? false : Promise.reject(error)),
        );
      if (landed && page.url() === threadUrl) break;
    }
    // 输入框光标闪烁会让相邻关键帧出现无意义差异。
    await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
    await sleep(1500);
    await story.prepare?.({ page, mail });

    const beats: Array<{
      label: string;
      file: string;
      target: Awaited<ReturnType<typeof boxOf>>;
      zoom: Step["zoom"] | null;
      hold: number;
    }> = [];
    for (const step of story.steps) {
      const box = await boxOf(page, step);
      if (step.target && step.click !== false) {
        await locate(page, step).click({ clickCount: step.clicks ?? 1 });
      }
      await step.after?.({ page, mail }).catch(async (error) => {
        await page.screenshot({ path: NodePath.join(outDir, `failed-${step.label}.png`) });
        throw error;
      });
      if (step.key) {
        // 鼠标停到标题栏空白处、焦点移走，免得悬停或聚焦提示留在画面里。
        await page.mouse.move(VIEWPORT.width * 0.45, 30);
        await page.keyboard.press(step.key);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
      await sleep(step.settle ?? 900);
      const file = `${String(beats.length).padStart(2, "0")}-${step.label}.png`;
      await page.screenshot({ path: NodePath.join(outDir, file) });
      beats.push({
        label: step.label,
        file,
        target: box,
        zoom: step.zoom ?? null,
        hold: step.hold ?? 1.6,
      });
    }
    NodeFS.writeFileSync(
      NodePath.join(outDir, "beats.json"),
      JSON.stringify({ viewport: VIEWPORT, scale: 2, dark, beats }, null, 2),
    );
    await browser.close();
  } finally {
    stop();
  }
  NodeChildProcess.execFileSync(
    "python3",
    ["-I", NodePath.join(import.meta.dirname, "compose.py"), outDir],
    { stdio: "inherit" },
  );
}

await main();
