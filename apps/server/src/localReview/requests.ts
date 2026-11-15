import * as DateTime from "effect/DateTime";

import { groupRequests, attributeRequest } from "./attribution.ts";
import { isCommitCommand } from "./mentions.ts";
import {
  loadSnapshot,
  loadThreadRuns,
  RUN_COLUMNS,
  RUN_MESSAGE_JOIN,
  toRun,
  type Query,
} from "./snapshot.ts";
import type { GitFacts, Request, RequestFiles, Snapshot } from "./types.ts";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CHUNK = 400;
const MAX_CHILD_DEPTH = 8;

export interface RequestHead {
  readonly requestId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly runCount: number;
  readonly origin: "user" | "agent";
  readonly childCount: number;
  readonly fileChangeCount: number;
  readonly commitCommandCount: number;
}

export interface ListInput {
  readonly threadId?: string | undefined;
  readonly days?: number | undefined;
  readonly includeUnchanged?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

const chunks = <A>(values: ReadonlyArray<A>) =>
  Array.from({ length: Math.ceil(values.length / CHUNK) }, (_, i) =>
    values.slice(i * CHUNK, (i + 1) * CHUNK),
  );
const marks = (values: ReadonlyArray<unknown>) => values.map(() => "?").join(",");

const COMMIT_PREDICATE = `(json_extract(payload_json, '$.input') LIKE '%git%commit%'
  OR json_extract(payload_json, '$.input') LIKE '%git%merge%'
  OR json_extract(payload_json, '$.input') LIKE '%git%cherry-pick%'
  OR json_extract(payload_json, '$.input') LIKE '%git%rebase%'
  OR json_extract(payload_json, '$.input') LIKE '%git%pull%'
  OR json_extract(payload_json, '$.input') LIKE '%git%revert%'
  OR json_extract(payload_json, '$.input') LIKE '%git am %')`;

interface Signal {
  fileChanges: number;
  commits: number;
}

async function readSignals(
  query: Query,
  column: "run_id" | "thread_id",
  keys: ReadonlyArray<string>,
) {
  const signals = new Map<string, Signal>();
  for (const part of chunks(keys)) {
    const rows = await query(
      `SELECT ${column} AS k,
          SUM(type = 'file_change') AS file_changes,
          SUM(type = 'command_execution' AND ${COMMIT_PREDICATE}) AS commits
        FROM orchestration_v2_projection_turn_items
        WHERE type IN ('file_change', 'command_execution') AND ${column} IN (${marks(part)})
        GROUP BY ${column}`,
      part,
    );
    for (const row of rows) {
      signals.set(String(row.k), {
        fileChanges: Number(row.file_changes ?? 0),
        commits: Number(row.commits ?? 0),
      });
    }
  }
  return signals;
}

export async function listRequests(query: Query, input: ListInput, nowMs: number) {
  const days = input.days ?? DEFAULT_DAYS;
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - days * DAY_MS));
  const rows = await query(
    `SELECT ${RUN_COLUMNS}, t.title AS thread_title
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      ${RUN_MESSAGE_JOIN}
      WHERE r.requested_at >= ? AND t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NULL
        ${input.threadId === undefined ? "" : "AND r.thread_id = ?"}
      ORDER BY r.thread_id, r.ordinal`,
    input.threadId === undefined ? [since] : [since, input.threadId],
  );
  const titles = new Map(rows.map((row) => [String(row.thread_id), String(row.thread_title)]));
  const byThread = Map.groupBy(rows.map(toRun), (run) => run.threadId);
  const requests = [...byThread].flatMap(([, runs]) => groupRequests(runs));

  const allRunIds = requests.flatMap((r) => r.runIds);
  const runSignals = await readSignals(query, "run_id", allRunIds);
  const subagentRows = [];
  for (const part of chunks([...byThread.keys()])) {
    subagentRows.push(
      ...(await query(
        `SELECT thread_id, run_id, child_thread_id FROM orchestration_v2_projection_subagents
          WHERE child_thread_id IS NOT NULL AND thread_id IN (${marks(part)})`,
        part,
      )),
    );
  }
  const childThreadsOfRun = new Map<string, string[]>();
  for (const row of subagentRows) {
    const key = String(row.run_id);
    childThreadsOfRun.set(key, [
      ...(childThreadsOfRun.get(key) ?? []),
      String(row.child_thread_id),
    ]);
  }
  const requestChildren = new Map<string, Set<string>>();
  for (const request of requests) {
    const set = new Set(request.runIds.flatMap((id) => childThreadsOfRun.get(id) ?? []));
    requestChildren.set(request.id, set);
  }
  let frontier = new Set([...requestChildren.values()].flatMap((s) => [...s]));
  const nested = new Map<string, string[]>();
  for (let depth = 1; depth < MAX_CHILD_DEPTH && frontier.size > 0; depth += 1) {
    const next = new Set<string>();
    for (const part of chunks([...frontier])) {
      for (const row of await query(
        `SELECT thread_id, child_thread_id FROM orchestration_v2_projection_subagents
          WHERE child_thread_id IS NOT NULL AND thread_id IN (${marks(part)})`,
        part,
      )) {
        const parent = String(row.thread_id);
        const child = String(row.child_thread_id);
        nested.set(parent, [...(nested.get(parent) ?? []), child]);
        next.add(child);
      }
    }
    frontier = next;
  }
  for (const set of requestChildren.values()) {
    const queue = [...set];
    for (const id of queue) {
      for (const child of nested.get(id) ?? []) {
        if (!set.has(child)) {
          set.add(child);
          queue.push(child);
        }
      }
    }
  }
  const childSignals = await readSignals(query, "thread_id", [
    ...new Set([...requestChildren.values()].flatMap((s) => [...s])),
  ]);

  const heads: RequestHead[] = requests.map((request) => {
    let fileChanges = 0;
    let commits = 0;
    for (const id of request.runIds) {
      fileChanges += runSignals.get(id)?.fileChanges ?? 0;
      commits += runSignals.get(id)?.commits ?? 0;
    }
    const children = requestChildren.get(request.id) ?? new Set<string>();
    for (const id of children) {
      fileChanges += childSignals.get(id)?.fileChanges ?? 0;
      commits += childSignals.get(id)?.commits ?? 0;
    }
    return {
      requestId: request.id,
      threadId: request.threadId,
      threadTitle: titles.get(request.threadId) ?? "",
      startedAt: request.startedAt,
      endedAt: request.endedAt,
      runCount: request.runIds.length,
      origin: request.origin,
      childCount: children.size,
      fileChangeCount: fileChanges,
      commitCommandCount: commits,
    };
  });
  const visible = (
    input.includeUnchanged === true
      ? heads
      : heads.filter((h) => h.fileChangeCount + h.commitCommandCount > 0)
  ).toSorted((a, b) => b.startedAt - a.startedAt || a.requestId.localeCompare(b.requestId));
  const start =
    input.cursor === undefined
      ? 0
      : visible.findIndex((h) => `${h.startedAt}|${h.requestId}` === input.cursor) + 1;
  const page = visible.slice(start, start + limit);
  const last = page.at(-1);
  return {
    requests: page,
    nextCursor:
      last !== undefined && start + limit < visible.length
        ? `${last.startedAt}|${last.requestId}`
        : null,
  };
}

async function findRequest(
  query: Query,
  threadId: string,
  requestId: string,
): Promise<Request | null> {
  const runs = await loadThreadRuns(query, threadId);
  return groupRequests(runs).find((request) => request.id === requestId) ?? null;
}

export function headOf(snapshot: Snapshot, request: Request, threadTitle: string): RequestHead {
  const children = new Set(snapshot.threads.map((t) => t.threadId));
  children.delete(request.threadId);
  return {
    requestId: request.id,
    threadId: request.threadId,
    threadTitle,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    runCount: request.runIds.length,
    origin: request.origin,
    childCount: children.size,
    fileChangeCount: snapshot.fileChanges.length,
    commitCommandCount: snapshot.commands.filter((c) => isCommitCommand(c.input)).length,
  };
}

export async function readRequest(
  query: Query,
  facts: GitFacts,
  threadId: string,
  requestId: string,
): Promise<{
  readonly request: Request;
  readonly snapshot: Snapshot;
  readonly result: RequestFiles;
} | null> {
  const request = await findRequest(query, threadId, requestId);
  if (request === null) return null;
  const snapshot = await loadSnapshot(query, threadId, request.runIds);
  return { request, snapshot, result: await attributeRequest(snapshot, request, facts) };
}
