import { ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const CONVERSATION_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"] as const;

interface CandidateRow {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly nativeSessionId: string;
  readonly hasBlockingOutbox: number | boolean;
}

interface SessionRow {
  readonly threadId: string;
  readonly providerSessionId: string;
}

interface RetainedSessionRow {
  readonly providerInstanceId: string;
  readonly nativeSessionId: string;
}

export interface AntigravityThreadCleanupResult {
  readonly waiting: boolean;
  readonly removedSessions: number;
}

const sessionKey = (providerInstanceId: string, nativeSessionId: string) =>
  `${providerInstanceId}\0${nativeSessionId}`;

const isCandidateRow = (row: Partial<CandidateRow>): row is CandidateRow =>
  typeof row.threadId === "string" &&
  typeof row.providerInstanceId === "string" &&
  typeof row.nativeSessionId === "string";

const isSessionRow = (row: Partial<SessionRow>): row is SessionRow =>
  typeof row.threadId === "string" && typeof row.providerSessionId === "string";

const isRetainedSessionRow = (row: Partial<RetainedSessionRow>): row is RetainedSessionRow =>
  typeof row.providerInstanceId === "string" && typeof row.nativeSessionId === "string";

/**
 * Removes native Antigravity session files belonging to deleted threads that are no longer
 * reachable from any retained thread's fork/subagent ancestry or shared session references.
 */
export const cleanDeletedAntigravitySessions = Effect.fn(
  "AntigravityThreadCleanup.cleanDeletedAntigravitySessions",
)(function* (input: {
  readonly stateDir: string;
  readonly sql: SqlClient.SqlClient;
  readonly providerSessions: Pick<
    ProviderSessionManager.ProviderSessionManagerV2["Service"],
    "isLive"
  >;
}) {
  const { sql, providerSessions } = input;
  const fs = yield* FileSystem.FileSystem;

  const rawCandidates = yield* sql<Partial<CandidateRow>>`
    WITH RECURSIVE retained_threads(thread_id) AS (
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
      UNION
      SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.forkedFrom.threadId') IS NOT NULL
      UNION
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    )
    SELECT DISTINCT
      t.thread_id AS "threadId",
      COALESCE(
        pt.provider_instance_id,
        json_extract(pt.payload_json, '$.providerInstanceId'),
        pt.provider
      ) AS "providerInstanceId",
      json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS "nativeSessionId",
      EXISTS (
        SELECT 1
        FROM orchestration_v2_effect_outbox e
        WHERE e.thread_id = t.thread_id
          AND e.status IN ('pending', 'running')
      ) AS "hasBlockingOutbox"
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_provider_threads pt ON pt.thread_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_threads rt WHERE rt.thread_id = t.thread_id)
      AND COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = 'antigravity'
      AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    UNION
    SELECT DISTINCT
      t.thread_id AS "threadId",
      COALESCE(
        a.provider_instance_id,
        json_extract(a.payload_json, '$.providerInstanceId'),
        pt.provider_instance_id,
        json_extract(pt.payload_json, '$.providerInstanceId'),
        pt.provider
      ) AS "providerInstanceId",
      json_extract(a.payload_json, '$.nativeThreadId') AS "nativeSessionId",
      EXISTS (
        SELECT 1
        FROM orchestration_v2_effect_outbox e
        WHERE e.thread_id = t.thread_id
          AND e.status IN ('pending', 'running')
      ) AS "hasBlockingOutbox"
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
    JOIN orchestration_v2_projection_run_attempts a ON a.run_id = r.run_id
    JOIN orchestration_v2_projection_provider_threads pt
      ON pt.provider_thread_id = a.provider_thread_id
    WHERE t.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_threads rt WHERE rt.thread_id = t.thread_id)
      AND COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = 'antigravity'
      AND json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
  `.pipe(NodeSqliteClient.readOnly);

  const rawSessionRows = yield* sql<Partial<SessionRow>>`
    WITH RECURSIVE retained_threads(thread_id) AS (
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
      UNION
      SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.forkedFrom.threadId') IS NOT NULL
      UNION
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    )
    SELECT DISTINCT
      pt.thread_id AS "threadId",
      pt.provider_session_id AS "providerSessionId"
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_provider_threads pt ON pt.thread_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_threads rt WHERE rt.thread_id = t.thread_id)
      AND COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = 'antigravity'
      AND pt.provider_session_id IS NOT NULL
    UNION
    SELECT DISTINCT
      t.thread_id AS "threadId",
      ps.provider_session_id AS "providerSessionId"
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_provider_sessions ps ON ps.thread_id = t.thread_id
    WHERE t.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_threads rt WHERE rt.thread_id = t.thread_id)
      AND COALESCE(ps.driver, json_extract(ps.payload_json, '$.driver')) = 'antigravity'
    UNION
    SELECT DISTINCT
      t.thread_id AS "threadId",
      ps.provider_session_id AS "providerSessionId"
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_provider_session_bindings b ON b.thread_id = t.thread_id
    JOIN orchestration_v2_projection_provider_sessions ps
      ON ps.provider_session_id = b.provider_session_id
    WHERE t.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM retained_threads rt WHERE rt.thread_id = t.thread_id)
      AND COALESCE(ps.driver, json_extract(ps.payload_json, '$.driver')) = 'antigravity'
  `.pipe(NodeSqliteClient.readOnly);

  const candidates = rawCandidates.filter(isCandidateRow);
  const sessionRows = rawSessionRows.filter(isSessionRow);
  if (candidates.length === 0 && sessionRows.length === 0) {
    return { waiting: false, removedSessions: 0 };
  }

  const liveChecks = new Map<string, boolean>();
  const blockedThreadIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.hasBlockingOutbox) {
      blockedThreadIds.add(candidate.threadId);
    }
  }
  for (const row of sessionRows) {
    let live = liveChecks.get(row.providerSessionId);
    if (live === undefined) {
      live = yield* providerSessions.isLive(ProviderSessionId.make(row.providerSessionId));
      liveChecks.set(row.providerSessionId, live);
    }
    if (live) {
      blockedThreadIds.add(row.threadId);
    }
  }

  let waiting = blockedThreadIds.size > 0;
  if (candidates.length === 0) {
    return { waiting, removedSessions: 0 };
  }

  const rawRetained = yield* sql<Partial<RetainedSessionRow>>`
    WITH RECURSIVE retained_threads(thread_id) AS (
      SELECT thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
      UNION
      SELECT json_extract(t.payload_json, '$.forkedFrom.threadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.forkedFrom.threadId') IS NOT NULL
      UNION
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
      FROM orchestration_v2_projection_threads t
      JOIN retained_threads retained ON retained.thread_id = t.thread_id
      WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    )
    SELECT DISTINCT
      COALESCE(
        pt.provider_instance_id,
        json_extract(pt.payload_json, '$.providerInstanceId'),
        pt.provider
      ) AS "providerInstanceId",
      json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS "nativeSessionId"
    FROM orchestration_v2_projection_provider_threads pt
    WHERE pt.thread_id IN (SELECT thread_id FROM retained_threads)
      AND COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = 'antigravity'
      AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
    UNION
    SELECT DISTINCT
      COALESCE(
        a.provider_instance_id,
        json_extract(a.payload_json, '$.providerInstanceId'),
        pt.provider_instance_id,
        json_extract(pt.payload_json, '$.providerInstanceId'),
        pt.provider
      ) AS "providerInstanceId",
      json_extract(a.payload_json, '$.nativeThreadId') AS "nativeSessionId"
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_run_attempts a ON a.run_id = r.run_id
    JOIN orchestration_v2_projection_provider_threads pt
      ON pt.provider_thread_id = a.provider_thread_id
    WHERE r.thread_id IN (SELECT thread_id FROM retained_threads)
      AND COALESCE(pt.driver, json_extract(pt.payload_json, '$.driver')) = 'antigravity'
      AND json_extract(a.payload_json, '$.nativeThreadId') IS NOT NULL
  `.pipe(NodeSqliteClient.readOnly);

  const retainedKeys = new Set(
    rawRetained
      .filter(isRetainedSessionRow)
      .map((row) => sessionKey(row.providerInstanceId, row.nativeSessionId)),
  );
  const blockedKeys = new Set(
    candidates
      .filter((row) => blockedThreadIds.has(row.threadId))
      .map((row) => sessionKey(row.providerInstanceId, row.nativeSessionId)),
  );

  const targets = new Map<
    string,
    { readonly providerInstanceId: string; readonly nativeSessionId: string }
  >();
  for (const row of candidates) {
    if (blockedThreadIds.has(row.threadId) || !isNativeSessionId(row.nativeSessionId)) continue;
    const key = sessionKey(row.providerInstanceId, row.nativeSessionId);
    if (retainedKeys.has(key) || blockedKeys.has(key) || targets.has(key)) continue;
    targets.set(key, {
      providerInstanceId: row.providerInstanceId,
      nativeSessionId: row.nativeSessionId,
    });
  }

  const profileRoots = new Map<string, string | null>();
  const resolveProfileRoot = Effect.fnUntraced(function* (providerInstanceId: string) {
    const cached = profileRoots.get(providerInstanceId);
    if (cached !== undefined) return cached;
    const { profile: profileDirectory } = yield* resolveAntigravityInstanceDirectories(
      input.stateDir,
      ProviderInstanceId.make(providerInstanceId),
    );
    const stat = yield* fs.lstat(profileDirectory).pipe(Effect.option);
    if (Option.isNone(stat) || stat.value.type !== "Directory") {
      profileRoots.set(providerInstanceId, null);
      return null;
    }
    const root = (yield* Effect.promise(() => antigravityProfileRoot(profileDirectory))) ?? null;
    profileRoots.set(providerInstanceId, root);
    return root;
  });

  let removedSessions = 0;
  for (const target of targets.values()) {
    const profileRoot = yield* resolveProfileRoot(target.providerInstanceId);
    if (profileRoot === null) continue;

    const removed = yield* Effect.gen(function* () {
      let removedAny = false;
      for (const suffix of CONVERSATION_SUFFIXES) {
        const managed = yield* Effect.promise(() =>
          antigravityManagedPath(
            profileRoot,
            ["antigravity-acp", "conversations", `${target.nativeSessionId}${suffix}`],
            "file",
          ),
        );
        if (managed === undefined) continue;
        yield* fs.remove(managed.path, { force: true });
        removedAny = true;
      }

      const managedBrain = yield* Effect.promise(() =>
        antigravityManagedPath(
          profileRoot,
          ["antigravity-acp", "brain", target.nativeSessionId],
          "directory",
        ),
      );
      if (managedBrain !== undefined) {
        yield* fs.remove(managedBrain.path, { recursive: true, force: true });
        removedAny = true;
      }

      const managedAnnotation = yield* Effect.promise(() =>
        antigravityManagedPath(
          profileRoot,
          ["antigravity-acp", "annotations", `${target.nativeSessionId}.pbtxt`],
          "file",
        ),
      );
      if (managedAnnotation !== undefined) {
        yield* fs.remove(managedAnnotation.path, { force: true });
        removedAny = true;
      }

      return removedAny;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("antigravity session cleanup failed", { cause }).pipe(
          Effect.as(false),
          Effect.tap(() =>
            Effect.sync(() => {
              waiting = true;
            }),
          ),
        ),
      ),
    );

    if (removed) removedSessions++;
  }

  if (removedSessions > 0) {
    yield* Effect.logInfo("storage cleanup removed antigravity session files", {
      sessionCount: removedSessions,
    });
  }

  return { waiting, removedSessions };
});
