import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import {
  decodePromptAdvisorItems,
  type PromptAdvisorRuntime,
} from "../textGeneration/promptAdvisor.cn.ts";
import {
  getPromptAdvisorConfig,
  type PromptAdvisorConfig,
} from "../textGeneration/promptAdvisorConfig.cn.ts";
import { resolvePromptAdvisor } from "../textGeneration/promptAdvisorRegistry.cn.ts";
import {
  appendSessionSpriteLedgerEntry,
  buildSessionSpriteTriagePrompt,
  countRecentWouldAdvance,
  evaluateThreadEligibility,
  formatSpriteDraftMessage,
  isWithinQuietHours,
  parseSessionSpriteTriage,
  readSessionSpriteLedger,
  type SessionSpriteLedgerEntry,
  type SessionSpriteLedgerSummary,
  type SessionSpriteThreadCandidate,
} from "../textGeneration/sessionSprite.cn.ts";
import {
  listAdvisorSnapshots,
  type SessionSpriteAdvisorSnapshot,
} from "../textGeneration/sessionSpriteRegistry.cn.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const DEFAULT_LEDGER_LIMIT = 30;
const MANUAL_SCAN_LIMIT = 5;
const BACKGROUND_POLL_INTERVAL = Duration.seconds(60);

export interface SessionSpriteServiceDeps {
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "findThread" | "getThreadShell">;
  readonly ledgerPath: string;
  readonly resolveAdvisor?: Effect.Effect<Option.Option<PromptAdvisorRuntime>>;
  readonly readConfig?: () => PromptAdvisorConfig;
  readonly readSnapshots?: () => ReadonlyArray<SessionSpriteAdvisorSnapshot>;
  readonly getProjectRoot?: (projectId: ProjectId) => Effect.Effect<string | undefined>;
  readonly now?: Effect.Effect<number>;
}

export interface SessionSpriteScanOptions {
  readonly trigger?: "periodic" | "manual";
  readonly bypassQuietHours?: boolean | undefined;
  readonly bypassIdle?: boolean | undefined;
}

export interface SessionSpriteScanResult {
  readonly scanned: number;
  readonly wouldAdvance: number;
  readonly blocked: number;
  readonly errors: number;
  readonly summary: SessionSpriteLedgerSummary;
  readonly entries: ReadonlyArray<SessionSpriteLedgerEntry>;
}

const toIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Runs one shadow-mode session-sprite scan across captured advisor snapshots.
 * Never mutates threads or dispatches messages; every evaluated candidate writes to the JSONL ledger.
 */
export const runSessionSpriteScan = Effect.fn("SessionSprite.scan")(function* (
  deps: SessionSpriteServiceDeps,
  options: SessionSpriteScanOptions = {},
) {
  const trigger = options.trigger ?? "periodic";
  const config = (deps.readConfig ?? getPromptAdvisorConfig)();
  const spriteConfig = config.sprite;
  const readNow = deps.now ?? Clock.currentTimeMillis;
  const nowMs = yield* readNow;

  const existing = yield* readSessionSpriteLedger(deps.ledgerPath, Number.POSITIVE_INFINITY);
  const idleResult = (
    scanned = 0,
    wouldAdvance = 0,
    blocked = 0,
    errors = 0,
  ): SessionSpriteScanResult => ({
    scanned,
    wouldAdvance,
    blocked,
    errors,
    summary: existing.summary,
    entries: existing.entries.slice(0, DEFAULT_LEDGER_LIMIT),
  });

  if (
    !options.bypassQuietHours &&
    spriteConfig.quietHoursEnabled &&
    isWithinQuietHours(
      DateTime.toDate(DateTime.makeUnsafe(nowMs)),
      spriteConfig.quietStartHour,
      spriteConfig.quietEndHour,
    )
  ) {
    return idleResult();
  }

  let recentWouldAdvance = countRecentWouldAdvance(existing.entries, nowMs);
  if (recentWouldAdvance >= spriteConfig.maxGlobalPerHour) {
    return idleResult();
  }

  const snapshots = (deps.readSnapshots ?? listAdvisorSnapshots)();
  const ledgerEntries = [...existing.entries];
  let scanned = 0;
  let wouldAdvance = 0;
  let blocked = 0;
  let errors = 0;

  const record = Effect.fn("SessionSprite.recordEntry")(function* (
    entry: SessionSpriteLedgerEntry,
  ) {
    yield* appendSessionSpriteLedgerEntry(deps.ledgerPath, entry);
    ledgerEntries.unshift(entry);
    scanned += 1;
  });

  for (const snapshot of snapshots) {
    if (trigger === "manual" && scanned >= MANUAL_SCAN_LIMIT) break;
    if (recentWouldAdvance >= spriteConfig.maxGlobalPerHour) break;

    const thread = yield* deps.projectionStore
      .findThread(snapshot.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const shell = yield* deps.projectionStore
      .getThreadShell(snapshot.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (thread === null || shell === null) continue;

    const workspaceRoot =
      deps.getProjectRoot === undefined
        ? undefined
        : yield* deps.getProjectRoot(thread.projectId).pipe(Effect.orElseSucceed(() => undefined));

    const candidate: SessionSpriteThreadCandidate = {
      threadId: snapshot.threadId,
      runId: snapshot.runId,
      threadTitle: thread.title,
      deletedAt:
        thread.deletedAt !== null
          ? DateTime.toEpochMillis(thread.deletedAt)
          : shell.deletedAt !== null
            ? DateTime.toEpochMillis(shell.deletedAt)
            : null,
      archivedAt: thread.archivedAt !== null ? DateTime.toEpochMillis(thread.archivedAt) : null,
      settledOverride: thread.settledOverride,
      settledAt: thread.settledAt !== null ? DateTime.toEpochMillis(thread.settledAt) : null,
      snoozedUntil:
        thread.snoozedUntil != null ? DateTime.toEpochMillis(thread.snoozedUntil) : null,
      activeRunId: shell.activeRunId,
      relationshipToParent: thread.lineage.relationshipToParent,
      delegatedFrom: thread.delegatedFrom,
      scheduledTaskId: snapshot.scheduledTaskId,
      pendingRequestCount: shell.pendingRuntimeRequest !== null ? 1 : 0,
      hasExplicitChoices: snapshot.hasExplicitChoices,
      worktreePath: thread.worktreePath,
      workspaceRoot,
      sampledAt: snapshot.sampledAt,
      lastHumanMessageAt:
        shell.latestUserAuthoredMessageAt != null
          ? DateTime.toEpochMillis(shell.latestUserAuthoredMessageAt)
          : shell.latestUserMessageAt != null
            ? DateTime.toEpochMillis(shell.latestUserMessageAt)
            : null,
    };

    const eligibility = evaluateThreadEligibility(candidate, spriteConfig, ledgerEntries, nowMs, {
      bypassIdle: options.bypassIdle,
    });
    if (!eligibility.ok) {
      // Avoid writing duplicate already_evaluated_run entries or locking out threads still cooling down.
      if (
        eligibility.reason === "already_evaluated_run" ||
        eligibility.reason === "not_idle_enough"
      ) {
        continue;
      }
      const entryTs = toIso(yield* readNow);
      yield* record({
        ts: entryTs,
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "blocked_thread",
        blockReason: eligibility.reason,
        keptItems: [],
        droppedItems: [],
        draftMessage: null,
        durationMs: 0,
      });
      blocked += 1;
      continue;
    }

    const items = decodePromptAdvisorItems(snapshot.encoded);
    if (items.length === 0) {
      const entryTs = toIso(yield* readNow);
      yield* record({
        ts: entryTs,
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "blocked_items",
        blockReason: "no_items",
        keptItems: [],
        droppedItems: [],
        draftMessage: null,
        durationMs: 0,
      });
      blocked += 1;
      continue;
    }

    const startedAt = yield* readNow;
    const runtime = yield* deps.resolveAdvisor ?? resolvePromptAdvisor;
    if (Option.isNone(runtime)) {
      const finishedAt = yield* readNow;
      yield* record({
        ts: toIso(finishedAt),
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "error",
        blockReason: "advisor_unavailable",
        keptItems: [],
        droppedItems: [],
        draftMessage: null,
        durationMs: Math.max(0, finishedAt - startedAt),
      });
      errors += 1;
      continue;
    }

    const prompt = buildSessionSpriteTriagePrompt({
      threadTitle: thread.title,
      lastReplyExcerpt: snapshot.lastReplyExcerpt,
      items,
    });
    const outcome = yield* runtime.value.runPrompt(prompt).pipe(Effect.result);
    const finishedAt = yield* readNow;
    const durationMs = Math.max(0, finishedAt - startedAt);
    if (outcome._tag === "Failure") {
      yield* record({
        ts: toIso(finishedAt),
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "error",
        blockReason: outcome.failure.detail,
        keptItems: [],
        droppedItems: [],
        draftMessage: null,
        durationMs,
      });
      errors += 1;
      continue;
    }

    const triage = parseSessionSpriteTriage(outcome.success, items);
    if (triage._tag === "Unparseable") {
      yield* record({
        ts: toIso(finishedAt),
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "error",
        blockReason: "unparseable_triage_output",
        keptItems: [],
        droppedItems: [],
        draftMessage: null,
        durationMs,
      });
      errors += 1;
      continue;
    }

    if (triage.keptItems.length === 0) {
      yield* record({
        ts: toIso(finishedAt),
        mode: "shadow",
        trigger,
        threadId: snapshot.threadId,
        threadTitle: thread.title,
        runId: snapshot.runId,
        decision: "blocked_items",
        blockReason: "no_a_grade_items",
        keptItems: [],
        droppedItems: triage.droppedItems,
        draftMessage: null,
        durationMs,
      });
      blocked += 1;
      continue;
    }

    const draftMessage = formatSpriteDraftMessage(triage.keptItems);
    yield* record({
      ts: toIso(finishedAt),
      mode: "shadow",
      trigger,
      threadId: snapshot.threadId,
      threadTitle: thread.title,
      runId: snapshot.runId,
      decision: "would_advance",
      blockReason: null,
      keptItems: triage.keptItems,
      droppedItems: triage.droppedItems,
      draftMessage,
      durationMs,
    });
    wouldAdvance += 1;
    recentWouldAdvance += 1;
    if (trigger === "periodic") break;
  }

  if (scanned === 0) {
    return idleResult();
  }
  const latest = yield* readSessionSpriteLedger(deps.ledgerPath, DEFAULT_LEDGER_LIMIT);
  return {
    scanned,
    wouldAdvance,
    blocked,
    errors,
    summary: latest.summary,
    entries: latest.entries,
  } satisfies SessionSpriteScanResult;
});

/**
 * Lightweight scoped polling fiber: wakes every 60s to check `config.sprite.enabled` and
 * `scanIntervalMinutes` so config updates apply immediately without server restart.
 */
export function makeSessionSpriteBackgroundLayer(
  deps: SessionSpriteServiceDeps & { readonly scanLock?: Semaphore.Semaphore },
) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      let lastScanAt = 0;
      const runPeriodic = Effect.gen(function* () {
        const config = (deps.readConfig ?? getPromptAdvisorConfig)();
        if (!config.sprite.enabled) return;
        const nowMs = yield* deps.now ?? Clock.currentTimeMillis;
        if (nowMs - lastScanAt < config.sprite.scanIntervalMinutes * 60_000) return;
        lastScanAt = nowMs;
        const scan = runSessionSpriteScan(deps, { trigger: "periodic" });
        yield* deps.scanLock === undefined ? scan : deps.scanLock.withPermits(1)(scan);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("session sprite periodic scan failed", { cause }),
        ),
      );
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(BACKGROUND_POLL_INTERVAL).pipe(Effect.andThen(runPeriodic))),
      );
    }),
  );
}
