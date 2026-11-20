// @effect-diagnostics nodeBuiltinImport:off -- Synchronous build-input integrity checks need Git/tar output and exact file bytes before extraction.
// cn 版 CLI 包复用官方 Release 的原生闭包：校验官方模板、解出 node_modules/resource-monitor/lib，并记录来源。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { cliArchiveFileName, cliArchiveStem } from "./build-cli-archive.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";

type CliPlatform = Parameters<typeof cliArchiveStem>[1];
type CliArch = Parameters<typeof cliArchiveStem>[2];

// 仅在依赖、补丁和 native 源码完全相同的 nightly 上复用官方闭包。
const officialBaselinePaths = [
  "native/resource-monitor",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "scripts/lib/cli-external-packages.ts",
];
const OfficialRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
});
const decodeOfficialRelease = Schema.decodeUnknownSync(OfficialRelease);
const hashFile = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const toolOutput = (command: string, args: string[], cwd?: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

export function validateTemplateMembers(names: string[], verbose: string[], stem: string) {
  if (!names.length || names.length !== verbose.length) throw new Error("Archive listing mismatch");
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const clean = name.replace(/\/$/, "");
    // 官方归档没有链接；全部拒绝链接/设备，且拒绝 tar 输出会转义的文件名。
    if (
      !/^[-d]/.test(verbose[i]!) ||
      !/^[A-Za-z0-9_$@+.,/()= -]+$/.test(name) ||
      name.includes(" ") ||
      clean.split("/").some((part) => !part || part === "." || part === "..") ||
      !(clean === stem || clean.startsWith(`${stem}/`)) ||
      seen.has(clean)
    ) {
      throw new Error(`Unsafe archive member: ${name}`);
    }
    seen.add(clean);
  }
  for (const member of [
    "node_modules",
    "resource-monitor",
    "client",
    stem.endsWith("win32-x64") ? "t3.exe" : "t3",
  ]) {
    if (!seen.has(`${stem}/${member}`)) throw new Error(`Missing archive member: ${member}`);
  }
}

export function assertX64Binary(
  file: string,
  platform: "linux" | "win",
  arch: "x64" | "arm64" | "ia32" = "x64",
) {
  const bytes = NodeFS.readFileSync(file);
  if (platform === "linux") {
    if (
      bytes.toString("hex", 0, 4) !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 62
    ) {
      throw new Error(`Expected Linux x64 ELF: ${file}`);
    }
  } else {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
    if (
      bytes.toString("ascii", 0, 2) !== "MZ" ||
      offset + 6 > bytes.length ||
      bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }[arch]
    ) {
      throw new Error(`Expected Windows x64 PE: ${file}`);
    }
  }
}

export function verifyOfficialTemplate(input: {
  repoRoot: string;
  hostPlatform: NodeJS.Platform;
  archive: string;
  metadata: string;
  sums: string;
  version: string;
  platform: CliPlatform;
  arch: CliArch;
}) {
  if (input.arch !== "x64" || input.platform === "mac")
    throw new Error("Template reuse only supports linux/win x64");
  const tag = `v${input.version}`;
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) throw new Error("Expected nightly tag");
  const git = (...args: string[]) => toolOutput("git", args, input.repoRoot).trim();
  git("merge-base", "--is-ancestor", tag, "HEAD");
  if (git("diff", tag, "--", ...officialBaselinePaths))
    throw new Error("Official native/dependency baseline mismatch");
  const original = JSON.parse(git("show", `${tag}:apps/server/package.json`));
  const current = JSON.parse(
    NodeFS.readFileSync(NodePath.join(input.repoRoot, "apps/server/package.json"), "utf8"),
  );
  if (JSON.stringify({ ...current, version: original.version }) !== JSON.stringify(original))
    throw new Error("Server dependency baseline mismatch");
  const release = decodeOfficialRelease(JSON.parse(NodeFS.readFileSync(input.metadata, "utf8")));
  const releaseUrl = `https://github.com/pingdotgg/t3code/releases/tag/${tag}`;
  if (release.tag_name !== tag || release.html_url !== releaseUrl)
    throw new Error("Official release identity mismatch");
  const name = cliArchiveFileName(input.version, input.platform, input.arch);
  if (NodePath.basename(input.archive) !== name)
    throw new Error("Official archive basename mismatch");
  const verify = (assetName: string, file: string) => {
    const matches = release.assets.filter((asset) => asset.name === assetName);
    const asset = matches[0];
    const hash = hashFile(file);
    if (
      matches.length !== 1 ||
      !asset ||
      asset.browser_download_url !==
        `https://github.com/pingdotgg/t3code/releases/download/${tag}/${assetName}` ||
      asset.size !== NodeFS.statSync(file).size ||
      asset.digest !== `sha256:${hash}`
    )
      throw new Error(`Official asset hash/size/URL mismatch: ${assetName}`);
    return hash;
  };
  const archiveHash = verify(name, input.archive);
  const sumsHash = verify("SHA256SUMS", input.sums);
  const sums = NodeFS.readFileSync(input.sums, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.endsWith(`  ${name}`));
  if (sums.length !== 1 || sums[0] !== `${archiveHash}  ${name}`)
    throw new Error("SHA256SUMS mismatch");
  const tar = input.hostPlatform === "win32" ? windowsSystemTar() : "tar";
  const listing = (flag: string) => toolOutput(tar, [flag, input.archive]).trimEnd().split(/\r?\n/);
  validateTemplateMembers(
    listing("-tf"),
    listing("-tvf"),
    cliArchiveStem(input.version, input.platform, input.arch),
  );
  return {
    tag,
    upstreamCommit: git("rev-parse", `${tag}^{commit}`),
    releaseUrl,
    archiveHash,
    sumsHash,
    baselineTrees: git("ls-tree", tag, ...officialBaselinePaths).split("\n"),
  };
}

export const stageOfficialTemplate = Effect.fn("stageOfficialTemplate")(function* (input: {
  repoRoot: string;
  hostPlatform: NodeJS.Platform;
  archive: string;
  metadata: string;
  sums: string;
  version: string;
  platform: CliPlatform;
  arch: CliArch;
  stageRoot: string;
  contentDir: string;
}) {
  const provenance = yield* Effect.sync(() => verifyOfficialTemplate(input));
  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  yield* Effect.sync(() =>
    NodeChildProcess.execFileSync(
      input.hostPlatform === "win32" ? windowsSystemTar() : "tar",
      [
        "-xf",
        input.archive,
        "-C",
        input.stageRoot,
        `${stem}/node_modules`,
        `${stem}/resource-monitor`,
        ...(input.platform === "linux" ? [`${stem}/lib`] : []),
      ],
      { stdio: "inherit" },
    ),
  );
  const reused: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (relative: string) => {
    const absolute = NodePath.join(input.contentDir, relative);
    const stat = NodeFS.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of NodeFS.readdirSync(absolute).sort()) walk(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      if (
        /\.(node|dll|exe|so|so\.1)$/.test(relative) ||
        relative.endsWith("/t3-resource-monitor")
      ) {
        // node-pty 的源包保留其他 Windows 架构的 vendor 工具，ffi-rs 同时带 ia32 sibling。
        // 这些不供 x64 loader 使用，但也按目录声明校验其真实 PE 架构，完整记录原字节。
        const vendor = relative.includes("/third_party/conpty/");
        const arch =
          vendor && relative.includes("/win10-arm64/")
            ? "arm64"
            : relative.includes("/@yuuang/ffi-rs-win32-ia32-msvc/")
              ? "ia32"
              : "x64";
        assertX64Binary(absolute, vendor ? "win" : (input.platform as "linux" | "win"), arch);
      }
      reused.push({ path: relative, bytes: stat.size, sha256: hashFile(absolute) });
    } else throw new Error(`Unexpected extracted file type: ${relative}`);
  };
  yield* Effect.sync(() => {
    walk("node_modules");
    walk("resource-monitor");
    if (input.platform === "linux") walk("lib");
  });
  return { ...provenance, reused };
});

export function templateReceipt(input: {
  provenance: object;
  archivePath: string;
  builtExecutable: string;
  repoRoot: string;
}) {
  return {
    ...input.provenance,
    candidateSha256: hashFile(input.archivePath),
    forkExecutableSha256: hashFile(input.builtExecutable),
    forkHead: toolOutput("git", ["rev-parse", "HEAD"], input.repoRoot).trim(),
    forkDiffSha256: NodeCrypto.createHash("sha256")
      .update(toolOutput("git", ["diff", "HEAD", "--binary"], input.repoRoot))
      .digest("hex"),
  };
}
