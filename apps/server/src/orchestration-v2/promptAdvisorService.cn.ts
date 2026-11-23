import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2PromptSuggestion,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { PromptAdvisorSampler } from "../textGeneration/promptAdvisor.cn.ts";
import { forkParked } from "../serverActivation.ts";
import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

// Commentary lines count against the page, so it must outlast a chatty run.
const TIMELINE_ITEMS = 48;
const MAX_REMEMBERED_RUNS = 256;
// A letter or 甲乙丙丁 label opens the line, bold or listed, with a separator behind it.
const OPTION_LABEL =
  /^\s*(?:[-*+•]|\d+[.)、])?\s*(?:\*\*|__)?\s*(?:选项|方案)?\s*(甲|乙|丙|丁|[A-D])(?:\*\*|__)?\s*(?:[.．、:：]|(?=[（(]))/gm;
const COMPACT_COMMAND = /^\/compact(?:\s|$)/;

/** Whether a reply already puts labelled options or a 待你定 section in front of the user. */
export function hasExplicitReplyChoices(reply: string): boolean {
  if (reply.includes("待你定")) return true;
  const labels = new Set([...reply.matchAll(OPTION_LABEL)].map((match) => match[1]));
  return labels.size >= 2;
}

type Message = { readonly role: "user" | "assistant"; readonly text: string };

function conversation(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const messages: Array<Message> = [];
  for (const { item } of rows) {
    const text =
      item.type === "user_message" || item.type === "assistant_message" ? item.text.trim() : "";
    if (text.length === 0) continue;
    if (item.type === "user_message") {
      const wake = item.createdBy === "agent" && item.creationSource === "provider";
      if (!wake && item.idleCompaction === undefined) messages.push({ role: "user", text });
    } else if (item.type === "assistant_message" && item.phase !== "commentary") {
      messages.push({ role: "assistant", text });
    }
  }
  return messages;
}

export interface PromptAdvisorServiceDeps {
  /** The Labs flag, read live. */
  readonly enabled: Effect.Effect<boolean>;
  readonly resolveAdvisor: Effect.Effect<Option.Option<PromptAdvisorSampler>>;
  readonly eventSink: Pick<EventSinkV2Shape, "stream" | "latestSequence">;
  readonly projectionStore: Pick<
    ProjectionStoreV2Shape,
    "findThread" | "getMessagesById" | "getThreadShell" | "getTimelinePage"
  >;
  readonly publish: (
    threadId: ThreadId,
    suggestion: NonNullable<OrchestrationV2PromptSuggestion>,
  ) => Effect.Effect<void>;
}

/**
 * One advisor sample after each completed run, whatever provider ran it. The sample is dropped when
 * a newer run starts, the thread closes or leaves the latest run behind. While an advisor exists
 * the providers' own next-prompt prediction is off, so a turn is never sampled twice.
 */
export const makePromptAdvisorService = Effect.fn("PromptAdvisorService.make")(function* (
  deps: PromptAdvisorServiceDeps,
) {
  const sampling = yield* FiberMap.make<ThreadId>();
  const handled = new Set<RunId>();

  const sampleCompletedRun = Effect.fn("PromptAdvisorService.sampleCompletedRun")(function* (
    run: OrchestrationV2Run,
  ) {
    if (!(yield* deps.enabled)) return;
    const advisor = yield* deps.resolveAdvisor;
    if (Option.isNone(advisor)) return;
    const { threadId } = run;
    const thread = yield* deps.projectionStore.findThread(threadId);
    if (
      thread === null ||
      thread.deletedAt !== null ||
      thread.lineage.relationshipToParent === "subagent" ||
      thread.delegatedFrom !== undefined
    ) {
      return;
    }
    const isLatest = Effect.map(
      deps.projectionStore.getThreadShell(threadId),
      (shell) =>
        shell !== null &&
        shell.latestRunId === run.id &&
        shell.activeRunId === null &&
        shell.latestRunBackgroundWake !== true,
    );
    if (!(yield* isLatest)) return;
    const page = yield* deps.projectionStore.getTimelinePage(threadId, {
      view: "messages",
      beforePosition: Number.POSITIVE_INFINITY,
      limit: TIMELINE_ITEMS,
    });
    const trigger = (yield* deps.projectionStore.getMessagesById(threadId, [
      run.userMessageId,
    ])).get(run.userMessageId);
    if (
      trigger === undefined ||
      (trigger.createdBy === "agent" && trigger.creationSource === "provider") ||
      COMPACT_COMMAND.test(trigger.text.trim())
    ) {
      return;
    }
    const messages = conversation(page.items);
    // A run with many commentary lines can push its own prompt out of the page.
    if (!messages.some((message) => message.role === "user")) {
      messages.unshift({ role: "user", text: trigger.text.trim() });
    }
    const reply = messages.at(-1);
    if (reply?.role !== "assistant") return;
    const text = yield* advisor.value.sample({
      messages,
      hasExplicitChoices: hasExplicitReplyChoices(reply.text),
    });
    if (text === null || !(yield* deps.enabled) || !(yield* isLatest)) return;
    yield* deps.publish(threadId, { runId: run.id, text });
  });

  const onRunUpdated = (run: OrchestrationV2Run) => {
    if (run.status !== "completed") {
      return FiberMap.remove(sampling, run.threadId);
    }
    if (
      handled.has(run.id) ||
      run.restartContinuationOfRunId !== undefined ||
      run.manualContinuationOfRunId !== undefined ||
      run.usageLimitContinuationOfRunId !== undefined ||
      run.delegatedTaskId !== undefined
    ) {
      return Effect.void;
    }
    handled.add(run.id);
    for (const remembered of handled) {
      if (handled.size <= MAX_REMEMBERED_RUNS) break;
      handled.delete(remembered);
    }
    return FiberMap.run(
      sampling,
      run.threadId,
      sampleCompletedRun(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("prompt advisor sample skipped", { threadId: run.threadId, cause }),
        ),
      ),
    ).pipe(Effect.asVoid);
  };

  yield* forkParked(
    deps.eventSink.latestSequence().pipe(
      Effect.flatMap((afterSequence) =>
        Stream.runForEach(
          deps.eventSink.stream({ eventType: "run.updated", afterSequence }),
          (stored) =>
            stored.event.type === "run.updated" ? onRunUpdated(stored.event.payload) : Effect.void,
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("prompt advisor stopped", { cause })),
    ),
  );

  return {
    /** Whether the providers' own next-prompt prediction should run: on, and no advisor to replace it. */
    nativeSuggestions: Effect.flatMap(deps.enabled, (enabled) =>
      enabled ? Effect.map(deps.resolveAdvisor, Option.isNone) : Effect.succeed(false),
    ),
  };
});
