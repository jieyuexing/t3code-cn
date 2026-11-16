// @effect-diagnostics nodeBuiltinImport:off
// The attribution core is plain async code (replay scripts drive it without an Effect runtime); this service wraps it.
import * as NodeOS from "node:os";

import {
  LocalReviewError,
  ThreadId,
  type LocalReviewGetInput,
  type LocalReviewGetResult,
  type LocalReviewListInput,
  type LocalReviewListResult,
  type LocalReviewRequestHead,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { createGitFacts } from "./gitFacts.ts";
import {
  headOf,
  listRequests,
  readRequest,
  type RequestHead,
  type SignalCache,
} from "./requests.ts";
import type { Query } from "./snapshot.ts";

const CACHE_SIZE = 128;
const SIGNAL_CACHE_SIZE = 20_000;

export class LocalReviewService extends Context.Service<
  LocalReviewService,
  {
    readonly list: (
      input: LocalReviewListInput,
    ) => Effect.Effect<LocalReviewListResult, LocalReviewError>;
    readonly get: (
      input: LocalReviewGetInput,
    ) => Effect.Effect<LocalReviewGetResult, LocalReviewError>;
  }
>()("t3/localReview/LocalReviewService") {}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const wireHead = (head: RequestHead): LocalReviewRequestHead => ({
  ...head,
  threadId: ThreadId.make(head.threadId),
  startedAt: iso(head.startedAt),
  endedAt: iso(head.endedAt),
});

interface CacheEntry {
  readonly heads: ReadonlyMap<string, string>;
  readonly value: LocalReviewGetResult;
}

export const layer = Layer.effect(
  LocalReviewService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const query: Query = (text, params) =>
      runPromise(sql.unsafe<Record<string, unknown>>(text, params).pipe(NodeSqliteClient.readOnly));
    const cache = new Map<string, CacheEntry>();
    const signalCache: SignalCache = new Map();
    const home = NodeOS.homedir();

    const attempt = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new LocalReviewError({
            operation,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

    const list = Effect.fn("LocalReviewService.list")(function* (input: LocalReviewListInput) {
      if (signalCache.size > SIGNAL_CACHE_SIZE) signalCache.clear();
      const now = yield* Clock.currentTimeMillis;
      const result = yield* attempt("list", () => listRequests(query, input, now, signalCache));
      return { requests: result.requests.map(wireHead), nextCursor: result.nextCursor };
    });

    const get = Effect.fn("LocalReviewService.get")(function* (input: LocalReviewGetInput) {
      return yield* attempt("get", async () => {
        const [row] = await query(
          `SELECT t.title AS title, p.workspace_root AS root
            FROM orchestration_v2_projection_threads t
            LEFT JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
          [input.threadId],
        );
        if (row === undefined) throw new Error("Thread not found.");
        const facts = createGitFacts({
          scanRoot: typeof row.root === "string" ? row.root : home,
          home,
        });
        const key = `${input.threadId}|${input.requestId}`;
        const cached = cache.get(key);
        if (cached !== undefined && input.refresh !== true) {
          const current = await Promise.all(
            [...cached.heads.keys()].map(async (repo) => [repo, await facts.headOf(repo)] as const),
          );
          if (current.every(([repo, head]) => cached.heads.get(repo) === head)) return cached.value;
        }
        const read = await readRequest(query, facts, input.threadId, input.requestId);
        if (read === null) throw new Error("Request not found.");
        const { request, snapshot, result } = read;
        const value: LocalReviewGetResult = {
          head: wireHead(headOf(snapshot, request, String(row.title ?? ""))),
          files: result.files,
          commits: result.commits,
          deliverables: result.deliverables,
          mentionedCommits: result.mentionedCommits,
          clearedWorktrees: result.clearedWorktrees,
          omittedFiles: result.omittedFiles,
          blindSpots: result.blindSpots,
          gitCalls: result.gitCalls,
          complete: result.blindSpots.length === 0,
        };
        if (!request.running) {
          const repos = [...new Set(result.files.map((f) => f.repo))];
          const heads = new Map(
            await Promise.all(repos.map(async (repo) => [repo, await facts.headOf(repo)] as const)),
          );
          cache.delete(key);
          cache.set(key, { heads, value });
          const oldest = cache.keys().next();
          if (cache.size > CACHE_SIZE && oldest.done !== true) cache.delete(oldest.value);
        }
        return value;
      });
    });

    return LocalReviewService.of({ list, get });
  }),
);
