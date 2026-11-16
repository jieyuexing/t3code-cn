import {
  LocalReviewError,
  type LocalReviewLogInput,
  type LocalReviewLogResult,
  type LocalReviewRepo,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { createGitHistory, discoverRepos } from "./gitFacts.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DISCOVERY_TTL_MS = 30_000;

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
    const history = createGitHistory();

    const fail = (cause: unknown) =>
      new LocalReviewError({
        operation: "log",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    let discovered: { readonly at: number; readonly repos: ReadonlyArray<LocalReviewRepo> } | null =
      null;

    const log = Effect.fn("LocalReviewService.log")(function* (input: LocalReviewLogInput) {
      const now = yield* Clock.currentTimeMillis;
      if (discovered === null || now - discovered.at > DISCOVERY_TTL_MS) {
        const rows = yield* sql<{ readonly root: string }>`
          SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
        `.pipe(NodeSqliteClient.readOnly, Effect.mapError(fail));
        discovered = { at: now, repos: discoverRepos(rows.map((row) => row.root)) };
      }
      const { repos } = discovered;
      const selected =
        input.repo === undefined ? repos : repos.filter((repo) => repo.path === input.repo);
      if (input.repo !== undefined && selected.length === 0) {
        return yield* fail(new Error("Repository not found."));
      }
      return yield* Effect.tryPromise({
        try: async () =>
          input.part === "dirty"
            ? { repos, commits: [], dirty: await history.dirty(selected), hasMore: false }
            : {
                repos,
                ...(await history.commits(
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
