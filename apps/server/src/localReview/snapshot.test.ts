import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { groupRequests } from "./attribution.ts";
import { loadSnapshot, loadThreadRuns, type Query } from "./snapshot.ts";

function database() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, run_id TEXT, child_thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT);
    CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, run_id TEXT, type TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_checkpoints (thread_id TEXT, run_id TEXT, payload_json TEXT);
  `);
  const query: Query = async (sql, params) =>
    db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const insert = (table: string, values: ReadonlyArray<string | number | null>) =>
    db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`).run(...values);
  return { query, insert };
}

describe("loadSnapshot", () => {
  it("reads request causes and folds child threads, including items without a run id", async () => {
    const { query, insert } = database();
    const iso = (s: number) => `2027-01-15T08:00:${String(s).padStart(2, "0")}.000Z`;
    insert("orchestration_v2_projection_runs", [
      "R1",
      "T",
      1,
      iso(0),
      iso(5),
      '{"userMessageId":"M1"}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "R2",
      "T",
      2,
      iso(10),
      iso(15),
      '{"userMessageId":"M2"}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "R3",
      "T",
      3,
      iso(20),
      iso(25),
      '{"userMessageId":"M3"}',
    ]);
    insert("orchestration_v2_projection_messages", ["M1", '{"createdBy":"user"}']);
    insert("orchestration_v2_projection_messages", [
      "M2",
      '{"createdBy":"agent","delegatedCompletion":{"parentRunId":"R1"}}',
    ]);
    insert("orchestration_v2_projection_messages", [
      "M3",
      '{"createdBy":"agent","notification":{"outcome":"completed"}}',
    ]);
    insert("orchestration_v2_projection_subagents", ["T", "R1", "C"]);
    insert("orchestration_v2_projection_subagents", ["T", "R1", null]);
    insert("orchestration_v2_projection_subagents", ["T", "R2", "Other"]);
    insert("orchestration_v2_projection_threads", ["T", "P", '{"worktreePath":null}']);
    insert("orchestration_v2_projection_threads", ["C", "P", '{"worktreePath":"/wt/c"}']);
    insert("projection_projects", ["P", "/root"]);
    insert("orchestration_v2_projection_turn_items", [
      "T",
      "R1",
      "command_execution",
      JSON.stringify({ startedAt: iso(1), completedAt: iso(2), input: "git status", output: "ok" }),
    ]);
    insert("orchestration_v2_projection_turn_items", [
      "T",
      "R2",
      "command_execution",
      JSON.stringify({ startedAt: iso(11), input: "other", output: "" }),
    ]);
    insert("orchestration_v2_projection_turn_items", [
      "C",
      null,
      "file_change",
      JSON.stringify({ fileName: "/wt/c/a.ts", diffStr: "big" }),
    ]);
    insert("orchestration_v2_projection_checkpoints", [
      "T",
      "R1",
      '{"files":[{"path":"docs/a.md"}]}',
    ]);

    const requests = groupRequests(await loadThreadRuns(query, "T"));
    expect(requests.map((r) => r.runIds)).toEqual([["R1", "R2", "R3"]]);

    const snapshot = await loadSnapshot(query, "T", ["R1"]);
    expect(snapshot.subagents.map((s) => s.childThreadId)).toEqual(["C", null]);
    expect(snapshot.threads.map((t) => [t.threadId, t.cwd]).toSorted()).toEqual([
      ["C", "/wt/c"],
      ["T", "/root"],
    ]);
    expect(snapshot.commands.map((c) => c.input)).toEqual(["git status"]);
    expect(snapshot.fileChanges).toEqual([{ threadId: "C", runId: null, path: "/wt/c/a.ts" }]);
    expect(snapshot.checkpoints).toEqual([{ threadId: "T", runId: "R1", files: ["docs/a.md"] }]);
  });
});
