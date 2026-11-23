// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_USER_INPUT / CORTEX_STEP_TYPE_PLANNER_RESPONSE in the native trajectory.
const USER_INPUT_STEP_TYPE = 14;
const PLANNER_RESPONSE_STEP_TYPE = 15;
const NATIVE_SESSION_ID = /^[\w-]+$/;
const conversationSegments = ["antigravity-acp", "conversations"];

class AntigravitySteerLogError extends Schema.TaggedError<AntigravitySteerLogError>()(
  "AntigravitySteerLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session log.";
  }
}

const steerLogError = (cause: unknown) => new AntigravitySteerLogError({ cause });

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: steerLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const hasPlannerResponseAfterSteer =
  (baselineIdx: number) =>
  (database: NodeSqlite.DatabaseSync): boolean => {
    const userRow = database
      .prepare("SELECT min(idx) AS idx FROM steps WHERE idx > ? AND step_type = ?")
      .get(baselineIdx, USER_INPUT_STEP_TYPE);
    const userIdx = userRow?.idx;
    if (typeof userIdx !== "number") return false;
    return (
      database
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(userIdx, PLANNER_RESPONSE_STEP_TYPE) !== undefined
    );
  };

/**
 * Wraps non-empty, non-slash mid-turn steer text in an explicit `<user_steer>` block
 * without altering the original text or trailing attachment path lines.
 */
export function wrapAntigravitySteerText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("/")) {
    return text;
  }
  return [
    "<user_steer>",
    "Mid-turn steer from the user. Acknowledge receipt first, prioritize this instruction to adjust current work, then decide whether to continue prior steps.",
    text,
    "</user_steer>",
  ].join("\n");
}

/**
 * Records the session log's current step index before sending a prompt-steer and
 * returns a read-only check verifying that both a new USER_INPUT and a subsequent
 * PLANNER_RESPONSE landed. Returns `undefined` when the log cannot be verified safely.
 */
export const watchAntigravitySteerDelivery = Effect.fn("AntigravitySteer.watch")(function* (
  profileDirectory: string,
  sessionId: string,
): Effect.fn.Return<(() => Effect.Effect<boolean | undefined>) | undefined> {
  if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, baselineIdx: -1 };
      }
      return { root, identity: database.info, baselineIdx: undefined };
    },
    catch: steerLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return undefined;
  }
  const baselineIdx =
    before.baselineIdx ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (baselineIdx === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the steer.");
    return undefined;
  }
  return Effect.fn("AntigravitySteer.check")(function* () {
    const after = yield* Effect.tryPromise({
      try: () => antigravityManagedPath(before.root, segments, "file"),
      catch: steerLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const sameFile =
      after !== undefined &&
      (before.identity === undefined ||
        (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    if (!sameFile) return undefined;
    return yield* readSteps(after.path, hasPlannerResponseAfterSteer(baselineIdx)).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not read the Antigravity session log after the steer."),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  });
});
