import type {
  Snapshot,
  SnapshotCheckpoint,
  SnapshotCommand,
  SnapshotFileChange,
  SnapshotRun,
  SnapshotSubagent,
  SnapshotThread,
} from "./types.ts";

export type Row = Readonly<Record<string, unknown>>;
export type Query = (
  sql: string,
  params: ReadonlyArray<string | number>,
) => Promise<ReadonlyArray<Row>>;

const MAX_DEPTH = 8;

const text = (value: unknown) => (typeof value === "string" ? value : null);
const millis = (value: unknown) => {
  const iso = text(value);
  return iso === null ? null : Date.parse(iso);
};
const marks = (values: ReadonlyArray<unknown>) => values.map(() => "?").join(",");

export const RUN_COLUMNS = `r.run_id, r.thread_id, r.ordinal, r.requested_at, r.completed_at,
        json_extract(m.payload_json, '$.createdBy') AS created_by,
        substr(json_extract(m.payload_json, '$.text'), 1, 400) AS message_text,
        json_extract(m.payload_json, '$.delegatedCompletion.parentRunId') AS parent_run_id,
        json_type(m.payload_json, '$.notification') AS notification`;

export const RUN_MESSAGE_JOIN = `LEFT JOIN orchestration_v2_projection_messages m
        ON m.message_id = json_extract(r.payload_json, '$.userMessageId')`;

export function toRun(row: Row): SnapshotRun {
  return {
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    ordinal: Number(row.ordinal),
    requestedAt: millis(row.requested_at) ?? 0,
    completedAt: millis(row.completed_at),
    messageText: text(row.message_text) ?? "",
    cause: {
      createdBy: text(row.created_by) ?? "user",
      delegatedParentRunId: text(row.parent_run_id),
      backgroundNotification: row.notification !== null && row.notification !== undefined,
    },
  };
}

export async function loadThreadRuns(query: Query, threadId: string): Promise<SnapshotRun[]> {
  const rows = await query(
    `SELECT ${RUN_COLUMNS} FROM orchestration_v2_projection_runs r ${RUN_MESSAGE_JOIN}
      WHERE r.thread_id = ? ORDER BY r.ordinal`,
    [threadId],
  );
  return rows.map(toRun);
}

export async function loadSnapshot(
  query: Query,
  threadId: string,
  runIds: ReadonlyArray<string>,
): Promise<Snapshot> {
  const subagents: SnapshotSubagent[] = [];
  const childThreads: string[] = [];
  const visited = new Set([threadId]);
  const frontier: Array<{ threadId: string; runIds: ReadonlyArray<string> | null; depth: number }> =
    [{ threadId, runIds, depth: 0 }];
  while (frontier.length > 0) {
    const next = frontier.shift()!;
    if (next.depth >= MAX_DEPTH) continue;
    const rows =
      next.runIds === null
        ? await query(
            `SELECT thread_id, run_id, child_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ?`,
            [next.threadId],
          )
        : await query(
            `SELECT thread_id, run_id, child_thread_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ? AND run_id IN (${marks(next.runIds)})`,
            [next.threadId, ...next.runIds],
          );
    for (const row of rows) {
      const child = text(row.child_thread_id);
      subagents.push({
        threadId: String(row.thread_id),
        runId: text(row.run_id),
        childThreadId: child,
      });
      if (child === null || visited.has(child)) continue;
      visited.add(child);
      childThreads.push(child);
      frontier.push({ threadId: child, runIds: null, depth: next.depth + 1 });
    }
  }

  const threadIds = [threadId, ...childThreads];
  const threadRows = await query(
    `SELECT t.thread_id, json_extract(t.payload_json, '$.worktreePath') AS worktree_path,
        p.workspace_root
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.thread_id IN (${marks(threadIds)})`,
    threadIds,
  );
  const threads: SnapshotThread[] = threadRows.map((row) => {
    const worktree = text(row.worktree_path);
    return {
      threadId: String(row.thread_id),
      cwd: worktree !== null && worktree.startsWith("/") ? worktree : text(row.workspace_root),
    };
  });

  const itemColumns = `thread_id, run_id, type,
    json_extract(payload_json, '$.startedAt') AS started_at,
    json_extract(payload_json, '$.completedAt') AS completed_at,
    json_extract(payload_json, '$.input') AS input,
    json_extract(payload_json, '$.output') AS output,
    json_extract(payload_json, '$.fileName') AS file_name`;
  const itemRows = [
    ...(await query(
      `SELECT ${itemColumns} FROM orchestration_v2_projection_turn_items
        WHERE type IN ('command_execution', 'file_change') AND run_id IN (${marks(runIds)})`,
      [...runIds],
    )),
    ...(childThreads.length === 0
      ? []
      : await query(
          `SELECT ${itemColumns} FROM orchestration_v2_projection_turn_items
            WHERE type IN ('command_execution', 'file_change') AND thread_id IN (${marks(childThreads)})`,
          childThreads,
        )),
  ];
  const commands: SnapshotCommand[] = [];
  const fileChanges: SnapshotFileChange[] = [];
  for (const row of itemRows) {
    const base = { threadId: String(row.thread_id), runId: text(row.run_id) };
    if (row.type === "file_change") {
      const path = text(row.file_name);
      if (path !== null) fileChanges.push({ ...base, path });
      continue;
    }
    const startedAt = millis(row.started_at);
    if (startedAt === null) continue;
    commands.push({
      ...base,
      startedAt,
      completedAt: millis(row.completed_at),
      input: text(row.input) ?? "",
      output: text(row.output) ?? "",
    });
  }

  const checkpointRows = [
    ...(await query(
      `SELECT thread_id, run_id, json_extract(payload_json, '$.files') AS files
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ? AND run_id IN (${marks(runIds)})`,
      [threadId, ...runIds],
    )),
    ...(childThreads.length === 0
      ? []
      : await query(
          `SELECT thread_id, run_id, json_extract(payload_json, '$.files') AS files
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id IN (${marks(childThreads)}) AND run_id IS NOT NULL`,
          childThreads,
        )),
  ];
  const checkpoints: SnapshotCheckpoint[] = checkpointRows.map((row) => {
    const files: ReadonlyArray<{ readonly path?: unknown }> =
      typeof row.files === "string" ? (JSON.parse(row.files) as never) : [];
    return {
      threadId: String(row.thread_id),
      runId: String(row.run_id),
      files: files.flatMap((f) => (typeof f.path === "string" ? [f.path] : [])),
    };
  });

  const runs = (await Promise.all(threadIds.map((id) => loadThreadRuns(query, id)))).flat();
  return { runs, threads, subagents, commands, fileChanges, checkpoints };
}
