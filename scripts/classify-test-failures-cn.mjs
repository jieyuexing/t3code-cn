// 把 vitest 的 JSON 报告（unit 与 browser 都是同一格式）里的失败按 scripts/known-failures-cn.json 归类：
// 表里有的是「已知（附编号）」，其余一律是「新失败」，有新失败就非零退出。
// 用法：node scripts/classify-test-failures-cn.mjs [--table <表文件>] <报告.json>...
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_TABLE = NodePath.join(import.meta.dirname, "known-failures-cn.json");

function readJson(file) {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不了 ${file}：${error.message}`, { cause: error });
  }
}

const REPO_ROOT = normalize(NodePath.resolve(import.meta.dirname, ".."));
function normalize(file) {
  return file.replaceAll("\\", "/");
}
const display = (file) =>
  file.startsWith(`${REPO_ROOT}/`) ? file.slice(REPO_ROOT.length + 1) : file;
const endsWithPath = (file, suffix) => file === suffix || file.endsWith(`/${suffix}`);

function loadTable(file = DEFAULT_TABLE) {
  const table = readJson(file);
  if (table.version !== 1 || !Array.isArray(table.failures)) {
    throw new Error(`${file} 不是 version 1 的已知失败表`);
  }
  const ids = new Set();
  for (const entry of table.failures) {
    for (const key of [
      "id",
      "file",
      "name",
      "firstSeen",
      "source",
      "reason",
      "upstream",
      "closeWhen",
    ]) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        throw new Error(`${file} 的条目缺 ${key}：${JSON.stringify(entry)}`);
      }
    }
    if (ids.has(entry.id)) throw new Error(`${file} 的编号重复：${entry.id}`);
    ids.add(entry.id);
  }
  return table.failures;
}

// 报告里没有 testResults 或 success 为假却找不到失败用例时，按新失败处理，不放过。
function classify(reports, table) {
  const known = [];
  const fresh = [];
  const passedKnown = new Set();
  for (const { file: reportFile, report } of reports) {
    if (!Array.isArray(report.testResults)) {
      fresh.push({ where: reportFile, detail: "报告里没有 testResults" });
      continue;
    }
    let failedInReport = 0;
    for (const suite of report.testResults) {
      const suiteFile = normalize(suite.name ?? "");
      let suiteHasFailedCase = false;
      for (const test of suite.assertionResults ?? []) {
        const entry = table.find(
          (item) => endsWithPath(suiteFile, item.file) && item.name === test.fullName,
        );
        if (test.status === "failed") {
          suiteHasFailedCase = true;
          failedInReport += 1;
          if (entry) known.push({ entry, where: suiteFile });
          else fresh.push({ where: suiteFile, detail: test.fullName });
        } else if (test.status === "passed" && entry) {
          passedKnown.add(entry.id);
        }
      }
      if (suite.status === "failed" && !suiteHasFailedCase) {
        failedInReport += 1;
        fresh.push({
          where: suiteFile,
          detail: `套件失败：${(suite.message ?? "").split("\n")[0]}`,
        });
      }
    }
    if (report.success === false && failedInReport === 0) {
      fresh.push({ where: reportFile, detail: "报告 success=false，但找不到失败用例" });
    }
  }
  const stale = table.filter((entry) => !entry.intermittent && passedKnown.has(entry.id));
  return { known, fresh, stale };
}

function formatSummary({ known, fresh, stale }) {
  const lines = [`已知失败 ${known.length} 条（scripts/known-failures-cn.json）`];
  for (const { entry, where } of known) {
    lines.push(`  ${entry.id}  ${display(where)} › ${entry.name}`);
  }
  lines.push(`新失败 ${fresh.length} 条（不在表里，按本次引入处理）`);
  for (const { where, detail } of fresh) lines.push(`  ${display(where)} › ${detail}`);
  if (stale.length > 0) {
    lines.push(
      `表内条目本次通过，可核对 closeWhen 后收口：${stale.map((entry) => entry.id).join("、")}`,
    );
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  let table = DEFAULT_TABLE;
  const reports = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--table") {
      table = argv[(index += 1)];
      if (!table) throw new Error("--table 后要跟表文件");
    } else reports.push(argv[index]);
  }
  if (reports.length === 0) throw new Error("至少给一个 vitest JSON 报告");
  return { table, reports };
}

function main() {
  const { table, reports } = parseArgs(process.argv.slice(2));
  const result = classify(
    reports.map((file) => ({ file, report: readJson(file) })),
    loadTable(table),
  );
  process.stdout.write(`${formatSummary(result)}\n`);
  process.exitCode = result.fresh.length > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
