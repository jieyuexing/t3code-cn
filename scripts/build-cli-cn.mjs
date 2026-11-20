#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

// 由 build-desktop-cn 的同一盖章/恢复事务调用；两个目标串行且各自立即归档。
const { values } = NodeUtil.parseArgs({
  options: Object.fromEntries(
    ["platform", "version", "official-archive", "release-metadata", "sha256sums", "output-dir"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
for (const name of [
  "platform",
  "version",
  "official-archive",
  "release-metadata",
  "sha256sums",
  "output-dir",
]) {
  if (!values[name]) throw new Error(`缺少 --${name}`);
}
if (!["linux", "win"].includes(values.platform)) throw new Error("只支持 linux/win x64");
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
let child;
let interrupted;
const forward = (signal) => {
  interrupted = signal;
  child?.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
async function run(command, args, { cwd = root, env = process.env } = {}) {
  if (interrupted) throw new Error(`构建已中断：${interrupted}`);
  await new Promise((resolve, reject) => {
    child = NodeChildProcess.spawn(command, args, {
      cwd,
      stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败：${signal ?? code}`));
    });
  });
}
const archiveArgs = [
  "scripts/build-cli-archive.ts",
  "--platform",
  values.platform,
  "--arch",
  "x64",
  "--version",
  values.version,
  ...["official-archive", "release-metadata", "sha256sums", "output-dir"].flatMap((name) => [
    `--${name}`,
    values[name],
  ]),
];
// CLI 目标 Node 固定在根 package.json 的 engines.node；SEA 宿主必须同版。
const nodeVersion = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"))
  .engines?.node;
if (!nodeVersion || process.versions.node !== nodeVersion)
  throw new Error(`SEA host must be Node ${nodeVersion}; running ${process.versions.node}`);
// 下载来源和依赖基线先验失败，不能花完构建时间才发现复用无效。
await run(process.execPath, [...archiveArgs, "--verify-template-only"]);
await run("vp", ["run", "--filter", "t3", "build"]);
await run(process.execPath, [
  "apps/server/scripts/cli.ts",
  "build-exe",
  "--target",
  `${values.platform}-x64`,
  "--verbose",
]);
// tsdown 0.23 的 SEA main 使用绝对路径；用同一已校验的目标 Node 再封装，
// 将 blob 中的源文件名改为仓库相对路径，避免候选泄漏构建者的 home 路径。
const hostPlatform = Effect.runSync(HostProcess.Platform);
const cacheRoot =
  hostPlatform === "darwin"
    ? NodePath.join(NodeOS.homedir(), "Library/Caches/tsdown")
    : hostPlatform === "win32"
      ? NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Local"),
          "tsdown/Caches",
        )
      : NodePath.join(
          process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
          "tsdown",
        );
const executable = NodePath.join(
  cacheRoot,
  "node",
  `v${nodeVersion}`,
  `${values.platform}-x64`,
  values.platform === "win" ? "node.exe" : "node",
);
// bin.mjs 只是 bootstrap，CLI 本体作为 binMain.mjs 资产内嵌；build-exe 用完即删资产目录，
// 这里按同一 pack 配置重出一份，资产与 execArgv 和 apps/server/vite.config.ts 的 seaConfig 保持一致。
const cliAssetDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-zh-cli-asset-"));
const seaConfig = NodePath.join(root, "apps/server/dist-exe/zh-sea-config.json");
try {
  await run("vp", ["pack"], {
    cwd: NodePath.join(root, "apps/server"),
    env: {
      ...process.env,
      T3CODE_PACK_EXE: "bundle",
      T3CODE_CLI_ASSET_DIR: cliAssetDir,
      T3CODE_PACK_EXE_TARGET: `${values.platform}-x64`,
    },
  });
  NodeFS.writeFileSync(
    seaConfig,
    JSON.stringify({
      main: "apps/server/dist-exe/bin.mjs",
      mainFormat: "module",
      executable,
      output: `apps/server/dist-exe/t3-${values.platform}-x64${values.platform === "win" ? ".exe" : ""}`,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      execArgv: ["--require-module"],
      assets: { "binMain.mjs": NodePath.join(cliAssetDir, "binMain.mjs") },
    }),
  );
  await run(process.execPath, ["--build-sea", seaConfig]);
} finally {
  NodeFS.rmSync(seaConfig, { force: true });
  NodeFS.rmSync(cliAssetDir, { recursive: true, force: true });
}
await run(process.execPath, archiveArgs);
