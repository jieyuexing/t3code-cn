import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** What a checkout is at, read live: unlike repository identity, never cached. */
export class ProjectCheckout extends Context.Service<
  ProjectCheckout,
  {
    /** The commit HEAD is at, or null when it cannot be read: not a repository, or no commit yet. */
    readonly head: (workspaceRoot: string) => Effect.Effect<string | null>;
    /** Whether tracked files differ from HEAD. New files Git does not track don't count. */
    readonly hasTrackedChanges: (workspaceRoot: string) => Effect.Effect<boolean>;
  }
>()("t3/project/ProjectCheckout") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;

  const head: ProjectCheckout["Service"]["head"] = Effect.fn("ProjectCheckout.head")(
    function* (workspaceRoot) {
      return yield* git.resolveCommit({ cwd: workspaceRoot, revision: "HEAD" }).pipe(
        Effect.map(({ commitSha }) => commitSha),
        Effect.orElseSucceed(() => null),
      );
    },
  );

  const hasTrackedChanges: ProjectCheckout["Service"]["hasTrackedChanges"] = Effect.fn(
    "ProjectCheckout.hasTrackedChanges",
  )(function* (workspaceRoot) {
    return yield* git
      .execute({
        operation: "ProjectCheckout.hasTrackedChanges",
        cwd: workspaceRoot,
        args: ["status", "--porcelain", "--untracked-files=no"],
      })
      .pipe(
        Effect.map(({ stdout }) => stdout.trim().length > 0),
        Effect.orElseSucceed(() => false),
      );
  });

  return ProjectCheckout.of({ head, hasTrackedChanges });
});

export const layer = Layer.effect(ProjectCheckout, make);
