import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  fileIdentity,
  readJson,
  writeJson,
  assertCandidate,
  sameSource,
  sha256,
} from "./release-source-zh.mjs";

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
export function parse7zListing(text) {
  const sections = text.split(/\r?\n----------\r?\n/);
  if (sections.length !== 2) throw new Error("Unrecognized 7z listing");
  const names = new Set();
  const rows = sections[1]
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split(/\r?\n/)
          .filter((line) => line.includes(" = "))
          .map((line) => {
            const i = line.indexOf(" = ");
            return [line.slice(0, i), line.slice(i + 3)];
          }),
      ),
    );
  for (const row of rows) {
    const name = safeRelative(row.Path);
    if (
      names.has(name.toLowerCase()) ||
      row["Symbolic Link"] ||
      row["Hard Link"] ||
      /l/.test(row.Attributes ?? "") ||
      row.Encrypted === "+"
    )
      throw new Error("Unsafe/duplicate 7z member");
    names.add(name.toLowerCase());
  }
  if (!rows.length) throw new Error("Empty payload");
  return rows;
}
function run(command, args, options = {}) {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}
export async function prepareWindows({ artifact, candidateFile, output, sevenZip }) {
  const candidate = readJson(candidateFile);
  assertCandidate(candidate, artifact);
  if (candidate.kind !== "nsis") throw new Error("Expected NSIS candidate");
  NodeFS.mkdirSync(output); // 不覆盖旧验证材料。
  const inner = NodePath.join(output, "app-64.7z");
  const fd = NodeFS.openSync(inner, "wx");
  try {
    run(sevenZip, ["x", "-so", artifact, "$PLUGINSDIR/app-64.7z"], {
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    NodeFS.closeSync(fd);
  }
  const listing = run(sevenZip, ["l", "-slt", inner]);
  parse7zListing(listing);
  NodeFS.writeFileSync(NodePath.join(output, "payload-listing.txt"), listing);
  const payload = NodePath.join(output, "payload-unpacked");
  run(sevenZip, ["x", "-y", `-o${payload}`, inner]);
  const asar = await import("@electron/asar");
  const { validateWindowsPackagedPayload } = await import("./build-desktop-artifact.ts");
  const Effect = await import("effect/Effect");
  const NodeServices = await import("@effect/platform-node/NodeServices");
  await Effect.runPromise(
    validateWindowsPackagedPayload({
      stageDistDir: output,
      appExecutableName: "T3 Code (Nightly).exe",
      targetArch: "x64",
      appVersion: candidate.version,
      expectWslRuntime: true,
      windowsCrossCandidate: true,
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  const resources = NodePath.join(payload, "resources");
  const sidecar = NodePath.join(output, "sidecar");
  const serverAsar = NodePath.join(resources, "server.asar");
  for (const member of asar.listPackage(serverAsar)) {
    const relative = safeRelative(member.replace(/^[/\\]+/, ""));
    if (asar.statFile(serverAsar, relative, false).link)
      throw new Error("ASAR links refused in Windows validation materials");
  }
  asar.extractAll(serverAsar, sidecar);
  const pkg = JSON.parse(
    asar.extractFile(NodePath.join(resources, "app.asar"), "package.json").toString(),
  );
  if (
    pkg.version !== candidate.version ||
    pkg.t3codeCommitHash !== candidate.source.head.slice(0, 12)
  )
    throw new Error("Packaged version/source mismatch");
  const embeddedWslSha256 = fileIdentity(NodePath.join(resources, "wsl-runtime.tar.gz")).sha256;
  if (embeddedWslSha256 !== candidate.embeddedWslSha256)
    throw new Error("Embedded Linux hash mismatch");
  const payloadRows = inventory(payload);
  for (const entry of payloadRows) {
    if (/(?:^|\/)(?:app-update|dev-app-update|latest(?:-mac|-linux)?)\.ya?ml$/.test(entry.path))
      throw new Error("Update feed refused");
    if (
      /\.exe$|\.node$|fff_c\.dll$/.test(entry.path) &&
      !entry.path.includes("ia32") &&
      !entry.path.includes("arm64") &&
      // node-pty ships prebuilds for every OS; only the win32 ones load on Windows.
      !/\/prebuilds\/(?:darwin|linux)-/.test(entry.path)
    ) {
      const data = NodeFS.readFileSync(NodePath.join(payload, entry.path));
      const offset = data.readUInt32LE(60);
      // electron-builder ships its NSIS elevation helper as x86 for every target arch.
      const expectedMachine = entry.path === "resources/elevate.exe" ? 0x014c : 0x8664;
      if (
        data.toString("ascii", 0, 2) !== "MZ" ||
        data.toString("ascii", offset, offset + 4) !== "PE\0\0" ||
        data.readUInt16LE(offset + 4) !== expectedMachine
      )
        throw new Error(`Wrong PE architecture: ${entry.path}`);
    }
  }
  NodeFS.copyFileSync(
    new URL("./windows-native-probe-zh.cjs", import.meta.url),
    NodePath.join(output, "windows-native-probe-zh.cjs"),
  );
  NodeFS.copyFileSync(
    new URL("./validate-windows-zh.ps1", import.meta.url),
    NodePath.join(output, "validate-windows-zh.ps1"),
  );
  const files = [
    ...payloadRows.map((r) => ({ ...r, path: `payload-unpacked/${r.path}` })),
    ...inventory(sidecar).map((r) => ({ ...r, path: `sidecar/${r.path}` })),
    ...["windows-native-probe-zh.cjs", "validate-windows-zh.ps1"].map((path) => ({
      path,
      ...fileIdentity(NodePath.join(output, path)),
    })),
  ];
  writeJson(NodePath.join(output, "materials.json"), {
    schema: 1,
    candidate,
    inner: fileIdentity(inner),
    embeddedWslSha256,
    files,
  });
  return {
    materialsSha256: fileIdentity(NodePath.join(output, "materials.json")).sha256,
    files: files.length,
    native: "pending",
  };
}

function stageResult(root, reference, stage, expectedExit = 0) {
  checkFiles(root, [reference]);
  const result = readJson(NodePath.join(root, reference.path));
  if (
    result.stage !== stage ||
    result.exitCode !== expectedExit ||
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
export function verifyReceipt(candidate, receiptFile, materialsDir) {
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
  if (candidate.kind === "nsis") {
    if (!materialsDir) throw new Error("Missing Windows extracted materials");
    const manifestPath = NodePath.join(materialsDir, "materials.json");
    const materials = readJson(manifestPath);
    if (
      receipt.materialsSha256 !== fileIdentity(manifestPath).sha256 ||
      JSON.stringify(materials.candidate) !== JSON.stringify(candidate) ||
      materials.embeddedWslSha256 !== candidate.embeddedWslSha256
    )
      throw new Error("Windows materials identity mismatch");
    checkFiles(materialsDir, materials.files);
    // 拒绝把旧或另一个探针签发的结果带到当前发布脚本。
    for (const name of ["windows-native-probe-zh.cjs", "validate-windows-zh.ps1"]) {
      if (
        fileIdentity(new URL(name, import.meta.url)).sha256 !==
        materials.files.find((r) => r.path === name)?.sha256
      )
        throw new Error("Probe source changed; rebuild and revalidate");
    }
    if (
      receipt.integrityBefore !== receipt.materialsSha256 ||
      receipt.integrityAfter !== receipt.materialsSha256 ||
      receipt.isolation?.environmentCleared !== true ||
      receipt.isolation?.noGlobalSearchPaths !== true ||
      receipt.isolation?.nodePath !== "" ||
      receipt.isolation?.monitorEnabled !== false ||
      !receipt.isolation?.ancestors?.length ||
      receipt.isolation.ancestors.some((x) => x.nodeModules !== false || x.reparse !== false)
    )
      throw new Error("Windows isolation/integrity missing");
    const results = {};
    const order = ["electron", "node", "bad", "good", "ffi", "fff", "keyring", "pty"];
    if (
      Object.keys(receipt.stages ?? {})
        .sort()
        .join() !== [...order].sort().join()
    )
      throw new Error("Missing Windows stages");
    for (const stage of order)
      results[stage] = stageResult(root, receipt.stages[stage], stage, stage === "bad" ? 1 : 0);
    if (Date.parse(results.bad.result.finishedUtc) > Date.parse(results.good.result.startedUtc))
      throw new Error("Bad sample must precede good sample");
    if (
      !/ERR_MODULE_NOT_FOUND/.test(results.bad.stderr) ||
      !/ffi-rs/.test(results.bad.stderr) ||
      receipt.removedDependency !== "ffi-rs" ||
      receipt.removedFiles < 1
    )
      throw new Error("Missing real dependency negative test");
    if (results.good.stdout.trim() !== `t3 v${candidate.version}`)
      throw new Error("Sidecar version mismatch");
    const events = (stage) =>
      results[stage].stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    const node = events("node")[0];
    if (
      node.platform !== "win32" ||
      node.arch !== "x64" ||
      node.nodePath !== "" ||
      node.monitorEnabled !== "false" ||
      JSON.stringify(node.globalPaths) !== "[]" ||
      !node.versions?.electron ||
      !node.versions?.node ||
      results.electron.stdout.trim() !== `v${node.versions.node}`
    )
      throw new Error("Wrong native runtime");
    for (const stage of ["ffi", "fff", "keyring"])
      if (!events(stage).some((e) => e.mode === stage && e.loaded === true))
        throw new Error(`Missing native load: ${stage}`);
    const pty = events("pty");
    if (
      !pty.some((e) => e.nativeLoaded === true) ||
      !pty.some(
        (e) =>
          e.event === "pty-exit" &&
          e.exitCode === 0 &&
          e.ok === true &&
          e.output.includes("T3ZH-PTY-OK"),
      ) ||
      !pty.some((e) => e.event === "probe-cleanup")
    )
      throw new Error("PTY evidence incomplete");
    return {
      scope:
        "Windows extracted payload: isolated version, missing ffi-rs red/green, native loads, bounded PTY with explicit probe cleanup",
    };
  }
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
      content.chineseBundle !== true ||
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
