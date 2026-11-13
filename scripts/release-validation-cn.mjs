import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileIdentity, readJson, sameSource, sha256 } from "./release-source-cn.mjs";

export function inventory(root, prefix = "") {
  const rows = [];
  for (const name of NodeFS.readdirSync(NodePath.join(root, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = NodePath.join(root, relative);
    const stat = NodeFS.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Link refused: ${relative}`);
    if (stat.isDirectory()) rows.push(...inventory(root, relative));
    else if (stat.isFile()) rows.push({ path: relative, ...fileIdentity(file) });
    else throw new Error(`Special file refused: ${relative}`);
  }
  return rows;
}
export function safeRelative(name) {
  if (
    typeof name !== "string" ||
    !name ||
    /[\\:\x00-\x1f]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw new Error("Unsafe evidence path");
  return name;
}
export function checkFiles(root, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Missing evidence files");
  const names = new Set();
  for (const entry of entries) {
    const name = safeRelative(entry.path);
    if (names.has(name.toLowerCase())) throw new Error("Duplicate evidence path");
    names.add(name.toLowerCase());
    let cursor = root;
    for (const part of name.split("/")) {
      cursor = NodePath.join(cursor, part);
      if (NodeFS.lstatSync(cursor).isSymbolicLink()) throw new Error("Evidence link refused");
    }
    const actual = fileIdentity(cursor);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes)
      throw new Error(`Evidence hash/bytes mismatch: ${name}`);
  }
}

function stageResult(root, reference, stage) {
  checkFiles(root, [reference]);
  const result = readJson(NodePath.join(root, reference.path));
  if (
    result.stage !== stage ||
    result.exitCode !== 0 ||
    result.timedOut !== false ||
    result.error !== null ||
    !(result.deadlineSeconds > 0 && result.deadlineSeconds <= 60)
  )
    throw new Error(`Native fail/timeout/invalid result: ${stage}`);
  if (
    !Number.isFinite(Date.parse(result.startedUtc)) ||
    !Number.isFinite(Date.parse(result.finishedUtc)) ||
    Date.parse(result.finishedUtc) < Date.parse(result.startedUtc)
  )
    throw new Error("Invalid stage timing");
  checkFiles(root, [result.stdout, result.stderr]);
  return {
    result,
    stdout: NodeFS.readFileSync(NodePath.join(root, result.stdout.path), "utf8"),
    stderr: NodeFS.readFileSync(NodePath.join(root, result.stderr.path), "utf8"),
  };
}
export function verifyReceipt(candidate, receiptFile) {
  const receipt = readJson(receiptFile);
  const root = NodePath.dirname(receiptFile);
  if (
    receipt.schema !== 1 ||
    receipt.kind !== candidate.kind ||
    receipt.version !== candidate.version ||
    receipt.platform !== candidate.platform ||
    receipt.arch !== candidate.arch ||
    receipt.artifactSha256 !== candidate.sha256 ||
    !sameSource(receipt.source, candidate.source)
  )
    throw new Error("Target receipt identity mismatch");
  const required =
    candidate.kind === "dmg"
      ? ["attach", "signature", "architecture", "plist", "content", "detach"]
      : ["version", "smoke"];
  if (
    Object.keys(receipt.stages ?? {})
      .sort()
      .join() !== [...required].sort().join()
  )
    throw new Error("Missing target stages");
  const results = Object.fromEntries(
    required.map((s) => [s, stageResult(root, receipt.stages[s], s)]),
  );
  if (candidate.kind === "dmg") {
    if (
      !results.attach.stdout.includes("<key>mount-point</key>") ||
      !results.detach.stdout.includes("ejected") ||
      results.architecture.stdout.trim() !== "arm64" ||
      results.plist.stdout.trim() !== candidate.version
    )
      throw new Error("DMG mount/architecture/plist/detach originals incomplete");
    const content = JSON.parse(results.content.stdout);
    if (
      content.version !== candidate.version ||
      content.arch !== "arm64" ||
      content.feedFree !== true ||
      content.readOnlyMount !== true ||
      content.sourceHead !== candidate.source.head ||
      !/^[a-f0-9]{64}$/.test(content.asarSha256 ?? "")
    )
      throw new Error("DMG content audit incomplete");
    if (!results.signature.stderr.includes("satisfies its Designated Requirement"))
      throw new Error("Missing codesign verification output");
    return { scope: "macOS signature and read-only DMG content; no GUI/install" };
  }
  if (
    !results.smoke.stdout.includes(
      `t3-${candidate.version}-${candidate.platform}-x64: --version passed and serve answered on `,
    ) ||
    receipt.monitorEnabled !== false ||
    results.version.stdout.trim() !== `t3 v${candidate.version}` ||
    results.smoke.result.monitorEnabled !== false ||
    results.smoke.result.environmentCleared !== true ||
    results.smoke.result.artifactSha256 !== candidate.sha256 ||
    results.smoke.result.server?.httpStatus !== 200 ||
    !results.smoke.result.server?.termination
  )
    throw new Error("CLI smoke output/monitor mismatch");
  return {
    scope:
      "Target CLI version and isolated HTTP smoke; no provider/application lifecycle acceptance",
  };
}
export const receiptDigest = (file) => sha256(NodeFS.readFileSync(file));
