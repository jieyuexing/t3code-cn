// 列出本次改动碰了的上游已有文件：高频冲突文件标 [HOT]，非测试文件增删合计超过阈值标 [WARN]，
// 词表文件汇总一行，已回到上游原样的文件不算。默认不阻断，加 --strict 时有告警以 1 退出。
// 用法：node scripts/check-upstream-intrusion-cn.mjs [--base <ref>] [--strict]
// 基准默认 origin/main（不存在则 HEAD）的合并基点，对比工作区（含暂存），不含未跟踪文件。
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

export const HOT_FILES = [
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/components/ChatView.tsx",
  "apps/server/src/mcp/OrchestratorMcpService.ts",
  "apps/server/src/server.ts",
  "apps/server/src/ws.ts",
  "packages/provider-acp/src/server/adapter.ts",
  "packages/contracts/src/settings.ts",
];
export const LINE_THRESHOLD = 15;

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/;
const I18N_CATALOG = /(?:^|\/)i18n\/translations\/[^/]+\.json$/;

/** @returns {Map<string, { added: number, deleted: number }>} */
export function parseNumstat(text) {
  const stats = new Map();
  for (const line of text.split("\n")) {
    const [added, deleted, ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    stats.set(rest.join("\t"), {
      added: Number(added) || 0,
      deleted: Number(deleted) || 0,
    });
  }
  return stats;
}

const ZERO = { added: 0, deleted: 0 };

// changed 是本次增删，cumulative 是相对最新 nightly 的累计，都是 parseNumstat 的结果。
export function classify({
  changed,
  cumulative,
  upstreamFiles,
  hotFiles = HOT_FILES,
  threshold = LINE_THRESHOLD,
}) {
  const hot = new Set(hotFiles);
  const result = { hot: [], warn: [], i18n: [] };
  for (const [file, now] of changed) {
    if (!upstreamFiles.has(file)) continue;
    const total = cumulative.get(file) ?? ZERO;
    if (total.added + total.deleted === 0) continue;
    const entry = { file, now, total };
    if (I18N_CATALOG.test(file)) result.i18n.push(entry);
    else if (hot.has(file)) result.hot.push(entry);
    else if (!TEST_FILE.test(file) && now.added + now.deleted > threshold) result.warn.push(entry);
  }
  return result;
}

const lines = ({ added, deleted }) => `+${added}/-${deleted}`;

/** @returns {string[]} */
export function formatReport({ hot, warn, i18n }, { threshold = LINE_THRESHOLD } = {}) {
  const out = [];
  if (hot.length === 0 && warn.length === 0) {
    out.push("fork upstream-intrusion: ok (0 upstream files above threshold)");
  } else {
    out.push(
      `fork upstream-intrusion: ${hot.length} hot, ${warn.length} above ${threshold} lines (non-test upstream files)`,
    );
    for (const { file, now, total } of hot) {
      out.push(`  [HOT]  ${file} ${lines(now)} this change, ${lines(total)} vs latest nightly`);
    }
    for (const { file, now, total } of warn) {
      out.push(`  [WARN] ${file} ${lines(now)} this change, ${lines(total)} vs latest nightly`);
    }
  }
  if (i18n.length > 0) {
    out.push(
      `i18n catalogs: ${i18n.length} files (remember: append at end only, preserve upstream key order)`,
    );
  }
  return out;
}

function git(args) {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitOk(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { base: "origin/main", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--strict") options.strict = true;
    else if (argv[index] === "--base") options.base = argv[++index] ?? options.base;
  }
  return options;
}

export function main(argv) {
  const { base, strict } = parseArgs(argv);
  const tag = gitOk(["tag", "--list", "v*-nightly.*", "--sort=-creatordate"])?.split("\n")[0];
  if (!tag) {
    console.log("fork upstream-intrusion: skipped (no v*-nightly.* tag in this repository)");
    return 0;
  }
  const baseRef = gitOk(["rev-parse", "--verify", "-q", `${base}^{commit}`]) ? base : "HEAD";
  const mergeBase = gitOk(["merge-base", baseRef, "HEAD"]) ?? "HEAD";
  const changed = parseNumstat(git(["diff", "--numstat", "--no-renames", mergeBase]));
  const upstreamFiles = new Set(git(["ls-tree", "-r", "--name-only", tag]).split("\n"));
  const touched = [...changed.keys()].filter((file) => upstreamFiles.has(file));
  const cumulative =
    touched.length === 0
      ? new Map()
      : parseNumstat(git(["diff", "--numstat", "--no-renames", tag, "--", ...touched]));
  const result = classify({ changed, cumulative, upstreamFiles });
  for (const line of formatReport(result)) console.log(line);
  return strict && (result.hot.length > 0 || result.warn.length > 0) ? 1 : 0;
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
