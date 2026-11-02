// 本地候选的源码身份包括维护脚本和未跟踪输入；不公开路径清单。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export function fileIdentity(file) {
  const stat = NodeFS.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${file}`);
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = NodeFS.readSync(fd, buffer))) hash.update(buffer.subarray(0, count));
  } finally {
    NodeFS.closeSync(fd);
  }
  return { bytes: stat.size, sha256: hash.digest("hex") };
}
export const readJson = (file) =>
  JSON.parse(NodeFS.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
export const writeJson = (file, value) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
export function git(root, ...args) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}
export function sourceIdentity(root) {
  const paths = [
    ...new Set(
      git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  // .env 是被忽略但会参与打包的输入；本地候选也不接受隐形配置。
  for (const dir of ["", "apps/server", "apps/web", "apps/desktop"]) {
    for (const name of NodeFS.readdirSync(NodePath.join(root, dir))) {
      if (/^\.env(?:\.|$)/.test(name) && !paths.includes(NodePath.posix.join(dir, name))) {
        throw new Error(`Ignored build input refused: ${NodePath.posix.join(dir, name)}`);
      }
    }
  }
  const gitlinks = new Map(
    git(root, "ls-files", "--stage", "-z")
      .split("\0")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => {
        const [meta, name] = line.split("\t");
        return [name, meta.split(" ")[1]];
      }),
  );
  const hash = NodeCrypto.createHash("sha256");
  for (const name of paths) {
    const file = NodePath.join(root, name);
    let entry;
    try {
      const stat = NodeFS.lstatSync(file);
      if (stat.isSymbolicLink()) entry = [name, "link", NodeFS.readlinkSync(file)];
      else if (stat.isFile())
        entry = [name, stat.mode & 0o111 ? "executable" : "file", fileIdentity(file).sha256];
      else if (stat.isDirectory() && gitlinks.has(name)) {
        if (NodeFS.readdirSync(file).length !== 0)
          throw new Error(`Populated gitlink needs an explicit source contract: ${name}`);
        entry = [name, "uninitialized-gitlink", gitlinks.get(name)];
      } else throw new Error(`Unsupported source input: ${name}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entry = [name, "deleted"];
    }
    hash.update(JSON.stringify(entry) + "\n");
  }
  return {
    head: git(root, "rev-parse", "HEAD"),
    treeSha256: hash.digest("hex"),
    dirty: git(root, "status", "--porcelain=v1", "--untracked-files=all") !== "",
  };
}
export function sameSource(left, right) {
  return (
    left?.head === right?.head &&
    left?.treeSha256 === right?.treeSha256 &&
    left?.dirty === right?.dirty
  );
}
export function artifactSpec(version, kind) {
  const specs = {
    dmg: { name: `T3-Code-${version}-arm64.dmg`, platform: "darwin", arch: "arm64" },
    linux: { name: `t3-${version}-linux-x64.tar.gz`, platform: "linux", arch: "x64" },
    windows: { name: `t3-${version}-win32-x64.zip`, platform: "win32", arch: "x64" },
  };
  if (!specs[kind]) throw new Error(`Unknown artifact kind: ${kind}`);
  return specs[kind];
}
export function assertCandidate(candidate, file) {
  if (candidate.schema !== 1 || !/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(candidate.version))
    throw new Error("Invalid candidate schema/version");
  const spec = artifactSpec(candidate.version, candidate.kind);
  if (
    candidate.upstreamTag !== `v${candidate.version}` ||
    !/^[a-f0-9]{40}$/.test(candidate.upstreamCommit ?? "")
  )
    throw new Error("Invalid upstream identity");
  for (const key of ["name", "platform", "arch"])
    if (candidate[key] !== spec[key]) throw new Error(`Candidate ${key} mismatch`);
  if (
    !/^[a-f0-9]{40}$/.test(candidate.source?.head ?? "") ||
    !/^[a-f0-9]{64}$/.test(candidate.source?.treeSha256 ?? "") ||
    typeof candidate.source.dirty !== "boolean"
  )
    throw new Error("Missing source identity");
  const actual = fileIdentity(file);
  if (
    NodePath.basename(file) !== spec.name ||
    candidate.sha256 !== actual.sha256 ||
    candidate.bytes !== actual.bytes
  )
    throw new Error("Candidate hash/bytes/name mismatch");
  if (candidate.structure !== "passed" || candidate.native !== "pending")
    throw new Error("Invalid build validation state");
  return actual;
}
