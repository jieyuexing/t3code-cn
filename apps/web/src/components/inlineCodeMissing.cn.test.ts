import { describe, expect, it, vi } from "vite-plus/test";

import {
  confirmMissingInlineCodePaths,
  INLINE_CODE_SEARCH_BUDGET,
  type InlineCodeProbe,
  type InlineCodeSearchResult,
} from "./inlineCodeMissing.cn";

const CWD = "/work/universe";
const probe = (path: string): InlineCodeProbe => ({ text: path, path });
const found = (...paths: string[]): InlineCodeSearchResult => ({
  entries: paths.map((path) => ({ path, kind: "file" as const })),
  truncated: false,
});
const NONE = found();

function run(
  probes: ReadonlyArray<InlineCodeProbe>,
  options: {
    exists?: ReadonlyArray<string>;
    stat?: (paths: string[]) => Promise<ReadonlyArray<unknown> | null>;
    search?: (root: string, query: string) => Promise<InlineCodeSearchResult | null>;
    otherRoots?: ReadonlyArray<string>;
  } = {},
) {
  const stat = vi.fn(
    options.stat ??
      (async (paths: string[]) =>
        paths.map((path) => (options.exists?.includes(path) ? {} : null))),
  );
  const search = vi.fn(options.search ?? (async () => NONE));
  return {
    stat,
    search,
    result: confirmMissingInlineCodePaths(probes, {
      cwd: CWD,
      otherRoots: options.otherRoots ?? [],
      stat,
      search,
    }),
  };
}

describe("confirmMissingInlineCodePaths", () => {
  it("marks a path absent only when the literal stat and the click's search both miss", async () => {
    const { result, stat, search } = run(
      [probe("history/OPERATIONS_HISTORY.md"), probe("src/exists.ts")],
      { exists: [`${CWD}/src/exists.ts`] },
    );
    expect(await result).toEqual(new Set(["history/OPERATIONS_HISTORY.md"]));
    expect(stat).toHaveBeenCalledExactlyOnceWith([
      `${CWD}/history/OPERATIONS_HISTORY.md`,
      `${CWD}/src/exists.ts`,
    ]);
    expect(search).toHaveBeenCalledExactlyOnceWith(CWD, "history/OPERATIONS_HISTORY.md");
  });

  it("keeps a path that only exists below the workspace root, as a click would open it", async () => {
    const { result } = run([probe("apps/web/src/a.ts")], {
      search: async () => found("projects/x/apps/web/src/a.ts"),
    });
    expect(await result).toEqual(new Set());
  });

  it("keeps a path another project of the environment has", async () => {
    const { result, search } = run([probe("src/a.ts")], {
      otherRoots: ["/work/other"],
      search: async (root) => (root === "/work/other" ? found("src/a.ts") : NONE),
    });
    expect(await result).toEqual(new Set());
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("treats a truncated, failed, or missing answer as unknown", async () => {
    const truncated = run([probe("a/b.ts")], {
      search: async () => ({ entries: [], truncated: true }),
    });
    expect(await truncated.result).toEqual(new Set());
    const failed = run([probe("a/b.ts")], { search: async () => null });
    expect(await failed.result).toEqual(new Set());
    const otherFailed = run([probe("a/b.ts")], {
      otherRoots: ["/work/other"],
      search: async (root) => (root === CWD ? NONE : null),
    });
    expect(await otherFailed.result).toEqual(new Set());
    const statFailed = run([probe("a/b.ts")], { stat: async () => null });
    expect(await statFailed.result).toEqual(new Set());
    expect(statFailed.search).not.toHaveBeenCalled();
  });

  it("decides a dot-relative path by its literal stat alone", async () => {
    const { result, search } = run([probe("./a/b.ts"), probe("../c/d.ts")]);
    expect(await result).toEqual(new Set(["./a/b.ts", "../c/d.ts"]));
    expect(search).not.toHaveBeenCalled();
  });

  it("never probes paths a chip could not stat", async () => {
    const { result, stat, search } = run([
      probe("~/notes/a.md"),
      probe("/abs/file.ts"),
      probe("//host/share/a.ts"),
      probe(`${"long/".repeat(120)}a.ts`),
    ]);
    expect(await result).toEqual(new Set());
    expect(stat).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("never stats below a network workspace root", async () => {
    const stat = vi.fn(async () => []);
    const missing = await confirmMissingInlineCodePaths([probe("src/a.ts")], {
      cwd: "//host/share/project",
      otherRoots: [],
      stat,
      search: async () => NONE,
    });
    expect(missing).toEqual(new Set());
    expect(stat).not.toHaveBeenCalled();
  });

  it("asks for at most one batch and leaves the overflow unknown", async () => {
    const probes = Array.from({ length: 70 }, (_, index) => probe(`dir/f${index}.ts`));
    const { result, stat } = run(probes, { search: async (_root, query) => found(query) });
    expect(await result).toEqual(new Set());
    expect(stat).toHaveBeenCalledOnce();
    expect(stat.mock.calls[0]![0]).toHaveLength(64);
  });

  it("stops searching at the budget and leaves the rest unknown", async () => {
    const probes = Array.from({ length: INLINE_CODE_SEARCH_BUDGET + 3 }, (_, index) =>
      probe(`dir/f${index}.ts`),
    );
    const { result, search } = run(probes);
    expect((await result).size).toBe(INLINE_CODE_SEARCH_BUDGET);
    expect(search).toHaveBeenCalledTimes(INLINE_CODE_SEARCH_BUDGET);
  });

  it("sends no request without candidates", async () => {
    const { result, stat } = run([]);
    expect(await result).toEqual(new Set());
    expect(stat).not.toHaveBeenCalled();
  });
});
