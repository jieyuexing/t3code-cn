/* eslint-disable t3code/no-global-process-runtime -- Standalone target runner must determine the actual native OS/arch without resolving application runtime services. */
// cn 版发行的目标回执入口：复用包内运行器，输出原始阶段记录供 publisher 重放。
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import { readJson, writeJson, fileIdentity, assertCandidate } from "./release-source-cn.mjs";
import { safeRelative, inventory } from "./release-validation-cn.mjs";

function stageWriter(output) {
  return (stage, result) => {
    const refs = {};
    for (const stream of ["stdout", "stderr"]) {
      const path = `${stage}.${stream}.txt`;
      NodeFS.writeFileSync(NodePath.join(output, path), result[stream] ?? "", { flag: "wx" });
      refs[stream] = { path, ...fileIdentity(NodePath.join(output, path)) };
    }
    const path = `${stage}.json`;
    writeJson(NodePath.join(output, path), { ...result, ...refs, stage });
    return { path, ...fileIdentity(NodePath.join(output, path)) };
  };
}
function baseReceipt(candidate) {
  return {
    schema: 1,
    kind: candidate.kind,
    version: candidate.version,
    platform: candidate.platform,
    arch: candidate.arch,
    source: candidate.source,
    artifactSha256: candidate.sha256,
    stages: {},
  };
}
function synchronous(command, args, options = {}) {
  const startedUtc = new Date().toISOString();
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    startedUtc,
    finishedUtc: new Date().toISOString(),
    deadlineSeconds: 60,
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function requireSuccess(result, stage) {
  if (result.exitCode !== 0 || result.timedOut || result.error)
    throw new Error(`${stage} failed; inspect private stage receipt`);
}
export async function auditDmg({ artifact, candidateFile, output }) {
  const candidate = readJson(candidateFile);
  assertCandidate(candidate, artifact);
  if (candidate.kind !== "dmg" || NodeOS.platform() !== "darwin" || NodeOS.arch() !== "arm64")
    throw new Error("DMG audit requires macOS arm64");
  NodeFS.mkdirSync(output);
  const record = stageWriter(output),
    receipt = baseReceipt(candidate);
  const mount = NodePath.join(output, "mount");
  NodeFS.mkdirSync(mount);
  const attach = synchronous("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-plist",
    "-mountpoint",
    mount,
    artifact,
  ]);
  receipt.stages.attach = record("attach", attach);
  requireSuccess(attach, "read-only attach");
  // 只卸载本次成功记录的挂载点。异常时不改用其他挂载方式。
  try {
    const app = NodePath.join(mount, "T3 Code (Nightly).app");
    const signature = synchronous("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      app,
    ]);
    receipt.stages.signature = record("signature", signature);
    requireSuccess(signature, "codesign");
    const start = new Date().toISOString();
    const resources = NodePath.join(app, "Contents/Resources");
    const executable = NodePath.join(app, "Contents/MacOS/T3 Code (Nightly)");
    const lipo = synchronous("lipo", ["-archs", executable]);
    receipt.stages.architecture = record("architecture", lipo);
    requireSuccess(lipo, "lipo");
    if (lipo.stdout.trim() !== "arm64") throw new Error("DMG executable architecture mismatch");
    const plist = synchronous("plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      NodePath.join(app, "Contents/Info.plist"),
    ]);
    receipt.stages.plist = record("plist", plist);
    requireSuccess(plist, "Info.plist");
    if (plist.stdout.trim() !== candidate.version) throw new Error("DMG plist version mismatch");
    const asar = await import("@electron/asar");
    const archive = NodePath.join(resources, "app.asar");
    const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString());
    if (
      pkg.version !== candidate.version ||
      pkg.t3codeCommitHash !== candidate.source.head.slice(0, 12)
    )
      throw new Error("DMG bundled version/source mismatch");
    for (const name of ["app-update.yml", "dev-app-update.yml", "latest.yml", "latest-mac.yml"])
      if (NodeFS.existsSync(NodePath.join(resources, name)))
        throw new Error("DMG update feed present");
    for (const member of asar.listPackage(archive)) {
      const name = member.replace(/^\//, "");
      if (/(?:^|\/)(?:\.env|userdata|\.ssh|\.aws|\.npmrc)(?:\/|$)|app-update\.yml$/.test(name))
        throw new Error("Private data or feed in ASAR");
    }
    const content = {
      version: candidate.version,
      arch: "arm64",
      feedFree: true,
      readOnlyMount: true,
      sourceHead: candidate.source.head,
      asarSha256: fileIdentity(archive).sha256,
    };
    receipt.stages.content = record("content", {
      startedUtc: start,
      finishedUtc: new Date().toISOString(),
      deadlineSeconds: 60,
      exitCode: 0,
      timedOut: false,
      error: null,
      stdout: JSON.stringify(content),
      stderr: "",
    });
  } finally {
    const detach = synchronous("hdiutil", ["detach", mount]);
    receipt.stages.detach = record("detach", detach);
    requireSuccess(detach, "owned mount detach");
  }
  assertCandidate(candidate, artifact);
  writeJson(NodePath.join(output, "receipt.json"), receipt);
  return receipt;
}

function assertAncestors(directory) {
  let cursor = NodePath.dirname(directory);
  for (;;) {
    if (
      NodeFS.lstatSync(cursor).isSymbolicLink() ||
      NodeFS.existsSync(NodePath.join(cursor, "node_modules"))
    )
      throw new Error("CLI ancestor isolation failed");
    const parent = NodePath.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export async function smokeCli({ artifact, candidateFile, output }) {
  const candidate = readJson(candidateFile);
  assertCandidate(candidate, artifact);
  if (
    !["linux", "windows"].includes(candidate.kind) ||
    NodeOS.platform() !== candidate.platform ||
    NodeOS.arch() !== candidate.arch
  )
    throw new Error("CLI smoke requires its native OS/arch");
  // 此入口补出发布所需的原件绑定、关闭 monitor、隔离环境和私有回执；不改上游 smoke 的合同。
  assertAncestors(output);
  NodeFS.mkdirSync(output);
  const record = stageWriter(output),
    receipt = baseReceipt(candidate);
  const tar =
    candidate.platform === "win32"
      ? NodePath.join(process.env.SystemRoot, "System32/tar.exe")
      : "tar";
  const listing = synchronous(tar, ["-tf", artifact]);
  record("listing", listing);
  requireSuccess(listing, "archive listing");
  const seen = new Set();
  const stem = `t3-${candidate.version}-${candidate.platform}-x64`;
  for (const item of listing.stdout.trim().split(/\r?\n/)) {
    const name = safeRelative(item.replace(/\/$/, ""));
    if (seen.has(name.toLowerCase()) || (name !== stem && !name.startsWith(stem + "/")))
      throw new Error("Invalid CLI archive path");
    seen.add(name.toLowerCase());
  }
  const verbose = synchronous(tar, ["-tvf", artifact]);
  requireSuccess(verbose, "archive types");
  if (
    verbose.stdout
      .trim()
      .split(/\r?\n/)
      .some((line) => !/^[d-]/.test(line))
  )
    throw new Error("CLI archive links/special files refused");
  const extracted = NodePath.join(output, "extracted");
  NodeFS.mkdirSync(extracted);
  const extraction = synchronous(tar, ["-xf", artifact, "-C", extracted]);
  record("extraction", extraction);
  requireSuccess(extraction, "archive extraction");
  const cwd = NodePath.join(extracted, stem);
  inventory(cwd);
  assertAncestors(cwd);
  const executable = NodePath.join(cwd, candidate.kind === "windows" ? "t3.exe" : "t3");
  const { assertX64Binary } = await import("./cli-official-template-cn.ts");
  assertX64Binary(executable, candidate.kind === "windows" ? "win" : "linux");
  const probeHome = NodePath.join(output, "home"),
    temp = NodePath.join(output, "temp");
  NodeFS.mkdirSync(probeHome);
  NodeFS.mkdirSync(temp);
  const env = {
    PATH: candidate.platform === "win32" ? NodePath.join(process.env.SystemRoot, "System32") : "",
    NODE_PATH: "",
    NODE_OPTIONS: "--no-global-search-paths",
    HOME: probeHome,
    USERPROFILE: probeHome,
    T3CODE_HOME: probeHome,
    CODEX_HOME: probeHome,
    CLAUDE_CONFIG_DIR: probeHome,
    XDG_CONFIG_HOME: probeHome,
    XDG_DATA_HOME: probeHome,
    XDG_CACHE_HOME: probeHome,
    APPDATA: probeHome,
    LOCALAPPDATA: probeHome,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    T3CODE_RESOURCE_MONITOR_ENABLED: "false",
  };
  for (const name of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "OS"])
    if (process.env[name]) env[name] = process.env[name];
  const startedUtc = new Date().toISOString();
  const version = synchronous(executable, ["--version"], { cwd, env, timeout: 20000 });
  receipt.stages.version = record("version", version);
  requireSuccess(version, "CLI version");
  if (version.stdout.trim() !== `t3 v${candidate.version}`) throw new Error("CLI version mismatch");
  const listener = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = NodeChildProcess.spawn(
    executable,
    ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    { cwd, env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  // 不保留 serve 启动配对信息；只记录自己的进程身份与 HTTP 结果。
  let spawnError,
    exited = false;
  const closed = new Promise((resolve) => {
    child.once("error", (e) => {
      spawnError = e;
    });
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  let httpStatus, termination;
  try {
    const deadline = Date.now() + 35000;
    // eslint-disable-next-line no-unmodified-loop-condition -- Child process events update these flags.
    while (Date.now() < deadline && !exited && !spawnError) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1500),
        });
        httpStatus = response.status;
        await response.body?.cancel();
        if (httpStatus === 200) break;
      } catch {
        /* 仅在有限启动窗口等待回环 HTTP。 */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    if (!exited) child.kill("SIGTERM");
    termination = await Promise.race([
      closed,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5000);
        timer.unref();
      }),
    ]);
    if (!termination) {
      child.kill("SIGKILL");
      termination = await Promise.race([
        closed,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 5000);
          timer.unref();
        }),
      ]);
    }
  }
  const passed = httpStatus === 200 && termination !== null && !spawnError;
  const result = {
    startedUtc,
    finishedUtc: new Date().toISOString(),
    deadlineSeconds: 60,
    exitCode: passed ? 0 : 1,
    timedOut: !termination || (!spawnError && httpStatus !== 200),
    error: spawnError?.message ?? null,
    stdout: passed ? `${stem}: --version passed and serve answered on ${port}.\n` : "",
    stderr: "",
    server: { pid: child.pid, httpStatus, termination },
    monitorEnabled: false,
    environmentCleared: true,
    artifactSha256: candidate.sha256,
  };
  receipt.stages.smoke = record("smoke", result);
  receipt.monitorEnabled = false;
  requireSuccess(result, "CLI smoke");
  assertCandidate(candidate, artifact);
  writeJson(NodePath.join(output, "receipt.json"), receipt);
  return receipt;
}
