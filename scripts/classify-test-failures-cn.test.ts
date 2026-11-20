// @effect-diagnostics nodeBuiltinImport:off -- Runs the classifier CLI as a subprocess against throwaway reports.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SCRIPT = NodePath.join(import.meta.dirname, "classify-test-failures-cn.mjs");
const REAL_TABLE = NodePath.join(import.meta.dirname, "known-failures-cn.json");

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "KF-9",
  file: "packages/x/src/a.test.ts",
  name: "suite known case",
  firstSeen: "2026-11-19",
  source: "fixture",
  reason: "fixture",
  upstream: "未复现",
  closeWhen: "fixture",
  ...overrides,
});

const result = (status: string, fullName: string) => ({ status, fullName });
const suite = (name: string, assertionResults: unknown[], status = "passed", message = "") => ({
  name,
  status,
  message,
  assertionResults,
});
const report = (testResults: unknown[], success = true) => ({ success, testResults });

function run(reports: unknown[], failures: unknown[] = [entry()]) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "classify-failures-"));
  try {
    const table = NodePath.join(dir, "table.json");
    NodeFS.writeFileSync(table, JSON.stringify({ version: 1, failures }));
    const files = reports.map((value, index) => {
      const file = NodePath.join(dir, `report${index}.json`);
      NodeFS.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
      return file;
    });
    const spawned = NodeChildProcess.spawnSync(
      process.execPath,
      [SCRIPT, "--table", table, ...files],
      { encoding: "utf8" },
    );
    return { code: spawned.status, out: spawned.stdout, err: spawned.stderr };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const known = suite("/abs/wt/packages/x/src/a.test.ts", [
  result("failed", "suite known case"),
  result("passed", "suite other case"),
]);

describe("classify-test-failures-cn", () => {
  it("passes when every failure is in the table and lists it with its id", () => {
    const { code, out } = run([report([known], false)]);
    expect(code).toBe(0);
    expect(out).toContain("已知失败 1 条");
    expect(out).toContain("KF-9");
    expect(out).toContain("新失败 0 条");
  });

  it("fails on a failure that is not in the table", () => {
    const unknown = suite("/abs/wt/packages/x/src/a.test.ts", [
      result("failed", "suite known case"),
      result("failed", "suite brand new case"),
    ]);
    const { code, out } = run([report([unknown], false)]);
    expect(code).toBe(1);
    expect(out).toContain("新失败 1 条");
    expect(out).toContain("suite brand new case");
  });

  it("does not match a table name in another file", () => {
    const other = suite("/abs/wt/packages/y/src/a.test.ts", [result("failed", "suite known case")]);
    expect(run([report([other], false)]).code).toBe(1);
  });

  it("fails on a suite that crashed before running any case", () => {
    const crashed = suite("/abs/wt/packages/x/src/b.test.ts", [], "failed", "Cannot find module");
    const { code, out } = run([report([crashed], false)]);
    expect(code).toBe(1);
    expect(out).toContain("套件失败：Cannot find module");
  });

  it("fails on success=false with no failed case, and on an empty report", () => {
    expect(run([report([suite("/abs/wt/a.test.ts", [])], false)]).code).toBe(1);
    expect(run([{ success: false }]).code).toBe(1);
  });

  it("merges unit and browser reports, failing if either has a new failure", () => {
    const browserNew = suite("/abs/wt/apps/web/src/c.browser.test.tsx", [result("failed", "x")]);
    const { code, out } = run([report([known], false), report([browserNew], false)]);
    expect(code).toBe(1);
    expect(out).toContain("已知失败 1 条");
    expect(out).toContain("新失败 1 条");
  });

  it("points out a table entry that passed, except intermittent ones", () => {
    const passed = suite("/abs/wt/packages/x/src/a.test.ts", [
      result("passed", "suite known case"),
    ]);
    expect(run([report([passed])]).out).toContain("可核对 closeWhen 后收口：KF-9");
    const flaky = run([report([passed])], [entry({ intermittent: true })]);
    expect(flaky.code).toBe(0);
    expect(flaky.out).not.toContain("收口");
  });

  it("exits 2 for an unreadable report or a malformed table", () => {
    expect(run(["not json"]).code).toBe(2);
    expect(run([report([known])], [entry({ reason: "" })]).code).toBe(2);
    expect(run([report([known])], [entry(), entry()]).code).toBe(2);
  });

  it("ships a table that loads", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "classify-real-"));
    try {
      const file = NodePath.join(dir, "empty.json");
      NodeFS.writeFileSync(file, JSON.stringify(report([])));
      const spawned = NodeChildProcess.spawnSync(
        process.execPath,
        [SCRIPT, "--table", REAL_TABLE, file],
        { encoding: "utf8" },
      );
      expect(spawned.status).toBe(0);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
