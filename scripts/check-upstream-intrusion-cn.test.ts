// @effect-diagnostics nodeBuiltinImport:off -- Loads the plain .mjs script by path.
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface Lines {
  readonly added: number;
  readonly deleted: number;
}
interface Entry {
  readonly file: string;
  readonly now: Lines;
  readonly total: Lines;
}
interface Classified {
  readonly hot: ReadonlyArray<Entry>;
  readonly warn: ReadonlyArray<Entry>;
  readonly i18n: ReadonlyArray<Entry>;
}
interface IntrusionModule {
  readonly parseNumstat: (text: string) => Map<string, Lines>;
  readonly classify: (input: {
    changed: Map<string, Lines>;
    cumulative: Map<string, Lines>;
    upstreamFiles: Set<string>;
  }) => Classified;
  readonly formatReport: (result: Classified) => ReadonlyArray<string>;
}

const script = NodeURL.pathToFileURL(
  NodePath.join(import.meta.dirname, "check-upstream-intrusion-cn.mjs"),
).href;
const { parseNumstat, classify, formatReport }: IntrusionModule = await import(script);

const HOT = "apps/server/src/ws.ts";
const PLAIN = "apps/server/src/provider/Drivers/AntigravityDriver.ts";
const TEST = "apps/server/src/textGeneration/AntigravityTextGeneration.test.ts";
const CATALOG = "apps/web/src/i18n/translations/de.json";
const CATALOG_2 = "apps/web/src/i18n/translations/fr.json";
const NEW_FILE = "apps/server/src/textGeneration/promptAdvisor.cn.ts";

const upstream = new Set([HOT, PLAIN, TEST, CATALOG, CATALOG_2]);
const run = (numstat: string, cumulative = numstat) =>
  classify({
    changed: parseNumstat(numstat),
    cumulative: parseNumstat(cumulative),
    upstreamFiles: upstream,
  });

describe("parseNumstat", () => {
  it("reads added and deleted counts and treats binary files as zero", () => {
    const stats = parseNumstat("3\t1\ta.ts\n-\t-\timg.png\n\n");
    expect(stats.get("a.ts")).toEqual({ added: 3, deleted: 1 });
    expect(stats.get("img.png")).toEqual({ added: 0, deleted: 0 });
    expect(stats.size).toBe(2);
  });
});

describe("classify and formatReport", () => {
  it("flags a hot upstream file however small the change", () => {
    const result = run(`1\t0\t${HOT}`, `40\t7\t${HOT}`);
    expect(result.hot.map((entry) => entry.file)).toEqual([HOT]);
    expect(formatReport(result)).toEqual([
      "fork upstream-intrusion: 1 hot, 0 above 15 lines (non-test upstream files)",
      `  [HOT]  ${HOT} +1/-0 this change, +40/-7 vs latest nightly`,
    ]);
  });

  it("warns only when an upstream file changes by more than 15 lines", () => {
    expect(run(`10\t5\t${PLAIN}`).warn).toEqual([]);
    const result = run(`10\t6\t${PLAIN}`, `30\t6\t${PLAIN}`);
    expect(result.warn).toHaveLength(1);
    expect(formatReport(result)[1]).toBe(
      `  [WARN] ${PLAIN} +10/-6 this change, +30/-6 vs latest nightly`,
    );
  });

  it("exempts test files and files the fork added", () => {
    const result = run(`200\t50\t${TEST}\n300\t0\t${NEW_FILE}`);
    expect(result.hot).toEqual([]);
    expect(result.warn).toEqual([]);
    expect(formatReport(result)).toEqual([
      "fork upstream-intrusion: ok (0 upstream files above threshold)",
    ]);
  });

  it("folds translation catalogs into one line instead of listing them", () => {
    const result = run(`50\t0\t${CATALOG}\n50\t0\t${CATALOG_2}`);
    expect(result.warn).toEqual([]);
    expect(formatReport(result)).toEqual([
      "fork upstream-intrusion: ok (0 upstream files above threshold)",
      "i18n catalogs: 2 files (remember: append at end only, preserve upstream key order)",
    ]);
  });

  it("ignores upstream files that are back to the upstream version", () => {
    const result = run(`3\t90\t${HOT}\n20\t20\t${PLAIN}`, `0\t0\t${HOT}`);
    expect(result.hot).toEqual([]);
    expect(result.warn).toEqual([]);
  });

  it("prints the clean line when nothing upstream changed", () => {
    expect(formatReport(run(""))).toEqual([
      "fork upstream-intrusion: ok (0 upstream files above threshold)",
    ]);
  });
});
