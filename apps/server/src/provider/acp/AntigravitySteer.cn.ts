// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import type * as NodeFS from "node:fs";
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

interface SteerWatchTicket {
  readonly root: string;
  readonly identity: NodeFS.Stats | undefined;
  readonly baselineIdx: number;
}

export interface AntigravitySteerTracker {
  readonly watch: () => Effect.Effect<symbol | undefined>;
  readonly reconcile: (
    tickets: ReadonlyArray<symbol>,
  ) => Effect.Effect<ReadonlyArray<boolean | undefined>>;
}

const isSameFile = (ticket: SteerWatchTicket, afterInfo: NodeFS.Stats): boolean =>
  ticket.identity === undefined ||
  (afterInfo.dev === ticket.identity.dev && afterInfo.ino === ticket.identity.ino);

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
 * Tracks mid-turn prompt-steers against `<sessionId>.db` with a monotonic USER_INPUT
 * consumption cursor and single-open batch reconciliation per flush.
 */
export function makeAntigravitySteerTracker(
  profileDirectory: string,
  sessionId: string,
): AntigravitySteerTracker {
  const segments = [...conversationSegments, `${sessionId}.db`];
  const ticketsById = new Map<symbol, SteerWatchTicket>();
  let lastConsumedUserIdx = -1;

  const watch = Effect.fn("AntigravitySteer.watch")(function* (): Effect.fn.Return<
    symbol | undefined
  > {
    if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
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
    const ticket = Symbol("AntigravitySteerTicket");
    ticketsById.set(ticket, {
      root: before.root,
      identity: before.identity,
      baselineIdx,
    });
    return ticket;
  });

  const reconcile = Effect.fn("AntigravitySteer.reconcile")(function* (
    tickets: ReadonlyArray<symbol>,
  ): Effect.fn.Return<ReadonlyArray<boolean | undefined>> {
    if (tickets.length === 0) return [];
    const entries = tickets.map((ticket) => ticketsById.get(ticket));
    const root = entries.find((entry) => entry !== undefined)?.root;
    if (root === undefined) return tickets.map(() => undefined);

    const after = yield* Effect.tryPromise({
      try: () => antigravityManagedPath(root, segments, "file"),
      catch: steerLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (after === undefined) return tickets.map(() => undefined);

    let minFloor: number | undefined;
    for (const entry of entries) {
      if (entry === undefined || !isSameFile(entry, after.info)) continue;
      const floor = Math.max(entry.baselineIdx, lastConsumedUserIdx);
      minFloor = minFloor === undefined ? floor : Math.min(minFloor, floor);
    }
    if (minFloor === undefined) return tickets.map(() => undefined);

    const queryFloor = minFloor;
    const resolved = yield* readSteps(after.path, (database) => {
      const rows = database
        .prepare(
          "SELECT idx, step_type FROM steps WHERE idx > ? AND step_type IN (?, ?) ORDER BY idx",
        )
        .all(queryFloor, USER_INPUT_STEP_TYPE, PLANNER_RESPONSE_STEP_TYPE) as ReadonlyArray<{
        readonly idx?: unknown;
        readonly step_type?: unknown;
      }>;
      const steps: Array<{ readonly idx: number; readonly stepType: number }> = [];
      for (const row of rows) {
        if (typeof row.idx === "number" && typeof row.step_type === "number") {
          steps.push({ idx: row.idx, stepType: row.step_type });
        }
      }

      let batchUserCursor = lastConsumedUserIdx;
      let confirmedUserCursor = lastConsumedUserIdx;
      const results: Array<boolean | undefined> = new Array<boolean | undefined>(
        tickets.length,
      ).fill(undefined);
      for (let i = 0; i < tickets.length; i += 1) {
        const entry = entries[i];
        if (entry === undefined || !isSameFile(entry, after.info)) {
          results[i] = undefined;
          continue;
        }
        const floor = Math.max(entry.baselineIdx, batchUserCursor);
        const userPos = steps.findIndex(
          (step) => step.idx > floor && step.stepType === USER_INPUT_STEP_TYPE,
        );
        if (userPos === -1) {
          results[i] = false;
          continue;
        }
        const userIdx = steps[userPos]!.idx;
        const hasResponse = steps.some(
          (step, pos) => pos > userPos && step.stepType === PLANNER_RESPONSE_STEP_TYPE,
        );
        batchUserCursor = userIdx;
        if (hasResponse) {
          confirmedUserCursor = userIdx;
          results[i] = true;
        } else {
          results[i] = false;
        }
      }
      return { results, confirmedUserCursor };
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not read the Antigravity session log after the steer."),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (resolved === undefined) return tickets.map(() => undefined);
    lastConsumedUserIdx = Math.max(lastConsumedUserIdx, resolved.confirmedUserCursor);
    return resolved.results;
  });

  return { watch, reconcile };
}

/**
 * Records the session log's current step index before sending a prompt-steer and
 * returns a read-only check verifying that both a new USER_INPUT and a subsequent
 * PLANNER_RESPONSE landed. Returns `undefined` when the log cannot be verified safely.
 */
export const watchAntigravitySteerDelivery = Effect.fn("AntigravitySteer.watchSingle")(function* (
  profileDirectory: string,
  sessionId: string,
): Effect.fn.Return<(() => Effect.Effect<boolean | undefined>) | undefined> {
  const tracker = makeAntigravitySteerTracker(profileDirectory, sessionId);
  const ticket = yield* tracker.watch();
  if (ticket === undefined) return undefined;
  return () => tracker.reconcile([ticket]).pipe(Effect.map((results) => results[0]));
});
