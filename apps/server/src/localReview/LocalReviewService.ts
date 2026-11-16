import {
  LocalReviewError,
  type LocalReviewLogInput,
  type LocalReviewLogResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { createGitHistory, discoverRepos } from "./gitFacts.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DISCOVERY_TTL = "30 seconds";

export class LocalReviewService extends Context.Service<
  LocalReviewService,
  {
    readonly log: (
      input: LocalReviewLogInput,
    ) => Effect.Effect<LocalReviewLogResult, LocalReviewError>;
  }
>()("t3/localReview/LocalReviewService") {}

export const layer = Layer.effect(
  LocalReviewService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Untracked scans are slow in big repos; their own git queue keeps them from delaying commit pages.
    const commitHistory = createGitHistory();
    const dirtyHistory = createGitHistory();

    const fail = (cause: unknown) =>
      new LocalReviewError({
        operation: "log",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    const findRepos = yield* Effect.cachedWithTTL(
      sql<{ readonly root: string }>`
        SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => discoverRepos(rows.map((row) => row.root))),
        Effect.mapError(fail),
      ),
      DISCOVERY_TTL,
    );

    const log = Effect.fn("LocalReviewService.log")(function* (input: LocalReviewLogInput) {
      const repos = yield* findRepos;
      const selected =
        input.repo === undefined ? repos : repos.filter((repo) => repo.path === input.repo);
      if (input.repo !== undefined && selected.length === 0) {
        return yield* fail(new Error("Repository not found."));
      }
      return yield* Effect.tryPromise({
        try: async () =>
          input.part === "dirty"
            ? { repos, commits: [], dirty: await dirtyHistory.dirty(selected), hasMore: false }
            : {
                repos,
                ...(await commitHistory.commits(
                  selected,
                  Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
                )),
                dirty: [],
              },
        catch: fail,
      });
    });

    return LocalReviewService.of({ log });
  }),
);
