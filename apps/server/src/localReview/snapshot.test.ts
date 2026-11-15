import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { groupRequests } from "./attribution.ts";
import { listRequests } from "./requests.ts";
import { loadSnapshot, loadThreadRuns, type Query } from "./snapshot.ts";

function database() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, run_id TEXT, child_thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, deleted_at TEXT, payload_json TEXT, updated_at TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.updatedAt')) VIRTUAL);
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
    insert("orchestration_v2_projection_threads", [
      "T",
      "P",
      "main thread",
      null,
      '{"worktreePath":null}',
    ]);
    insert("orchestration_v2_projection_threads", [
      "C",
      "P",
      "child",
      null,
      '{"worktreePath":"/wt/c","lineage":{"parentThreadId":"T"}}',
    ]);
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

  it("lists requests with coarse signals, folds child threads and pages", async () => {
    const { query, insert } = database();
    const at = (s: number) => `2027-01-15T08:00:${String(s).padStart(2, "0")}.000Z`;
    const now = Date.parse(at(59)) + 1000;
    insert("orchestration_v2_projection_threads", [
      "T",
      "P",
      "main thread",
      null,
      '{"lineage":{"parentThreadId":null}}',
    ]);
    insert("orchestration_v2_projection_threads", [
      "C",
      "P",
      "child",
      null,
      '{"lineage":{"parentThreadId":"T"}}',
    ]);
    insert("orchestration_v2_projection_threads", [
      "Q",
      "P",
      "quiet thread",
      null,
      '{"lineage":{"parentThreadId":null}}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "R1",
      "T",
      1,
      at(0),
      at(5),
      '{"userMessageId":"M1"}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "R2",
      "T",
      2,
      at(10),
      at(15),
      '{"userMessageId":"M2"}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "R3",
      "T",
      3,
      at(20),
      at(25),
      '{"userMessageId":"M3"}',
    ]);
    insert("orchestration_v2_projection_runs", [
      "Q1",
      "Q",
      1,
      at(30),
      at(35),
      '{"userMessageId":"MQ"}',
    ]);
    insert("orchestration_v2_projection_messages", [
      "M1",
      '{"createdBy":"user","text":"\\n  第一次请求的首行\\n第二行"}',
    ]);
    insert("orchestration_v2_projection_messages", [
      "M2",
      '{"createdBy":"agent","delegatedCompletion":{"parentRunId":"R1"}}',
    ]);
    insert("orchestration_v2_projection_messages", ["M3", '{"createdBy":"user"}']);
    insert("orchestration_v2_projection_messages", ["MQ", '{"createdBy":"user"}']);
    insert("orchestration_v2_projection_subagents", ["T", "R1", "C"]);
    insert("orchestration_v2_projection_turn_items", [
      "C",
      null,
      "file_change",
      '{"fileName":"/wt/c/a.ts"}',
    ]);
    insert("orchestration_v2_projection_turn_items", [
      "T",
      "R3",
      "command_execution",
      '{"input":"git -C /x commit -q -m y","output":""}',
    ]);
    insert("orchestration_v2_projection_turn_items", [
      "Q",
      "Q1",
      "command_execution",
      '{"input":"ls","output":""}',
    ]);

    const cache = new Map();
    const result = await listRequests(query, {}, now, cache);
    expect(
      result.requests.map((r) => [
        r.requestId,
        r.requestTitle,
        r.runCount,
        r.childCount,
        r.fileChangeCount,
        r.commitCommandCount,
      ]),
    ).toEqual([
      ["R3", "", 1, 0, 0, 1],
      ["R1", "第一次请求的首行", 2, 1, 1, 0],
    ]);
    expect(cache.size).toBeGreaterThan(0);
    insert("orchestration_v2_projection_turn_items", [
      "T",
      "R3",
      "file_change",
      '{"fileName":"/x/late.ts"}',
    ]);
    const again = await listRequests(query, {}, now, cache);
    expect(again.requests.find((r) => r.requestId === "R3")?.fileChangeCount).toBe(0);
    const everything = await listRequests(query, { includeUnchanged: true, limit: 2 }, now);
    expect(everything.requests.map((r) => r.requestId)).toEqual(["Q1", "R3"]);
    const next = await listRequests(
      query,
      { includeUnchanged: true, limit: 2, cursor: everything.nextCursor ?? undefined },
      now,
    );
    expect(next.requests.map((r) => r.requestId)).toEqual(["R1"]);
    expect(next.nextCursor).toBeNull();
    const single = await listRequests(query, { threadId: "Q", includeUnchanged: true }, now);
    expect(single.requests.map((r) => r.requestId)).toEqual(["Q1"]);
  });
});
