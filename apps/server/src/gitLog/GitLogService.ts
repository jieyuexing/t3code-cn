import { GitLogError, type GitLogListInput, type GitLogListResult } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { discoverRepos, readLog } from "./gitFacts.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2000;
const DISCOVERY_TTL = "30 seconds";

export class GitLogService extends Context.Service<
  GitLogService,
  {
    readonly list: (input: GitLogListInput) => Effect.Effect<GitLogListResult, GitLogError>;
  }
>()("t3/gitLog/GitLogService") {}

export const layer = Layer.effect(
  GitLogService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) =>
      new GitLogError({
        operation: "list",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    // The most recently used project's root comes first, so its repo is the default.
    const findRepos = yield* Effect.cachedWithTTL(
      sql<{ readonly root: string }>`
        SELECT workspace_root AS root FROM projection_projects
        WHERE deleted_at IS NULL ORDER BY updated_at DESC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => discoverRepos(rows.map((row) => row.root))),
        Effect.mapError(fail),
      ),
      DISCOVERY_TTL,
    );

    const list = Effect.fn("GitLogService.list")(function* (input: GitLogListInput) {
      const repos = yield* findRepos;
      const repo = input.repo === undefined ? repos[0]?.path : input.repo;
      if (repo === undefined) return { repos, repo: "", commits: [], hasMore: false };
      if (!repos.some((candidate) => candidate.path === repo)) {
        return yield* fail(new Error("Repository not found."));
      }
      const result = yield* Effect.tryPromise({
        try: () =>
          readLog(repo, {
            limit: Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
            query: input.query ?? "",
          }),
        catch: fail,
      });
      return { repos, repo, ...result };
    });

    return GitLogService.of({ list });
  }),
);
