import { useAtomValue } from "@effect/atom-react";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { create } from "zustand";

import { useStableCallback } from "~/hooks/useStableCallback";
import { orchestrationEnvironment } from "~/state/orchestration";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  buildEntries,
  missingTextJobs,
  needsYouThreads,
  sameNeedsYouThreads,
  type NeedsYouEntry,
  type NeedsYouThread,
  type TextJob,
} from "./needsYou.logic";
import { pendingItems } from "./replyPending";

const READ_CONCURRENCY = 4;

const needsYouThreadsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlyArray<NeedsYouThread> = [];
  return Atom.make((get) => {
    const next = needsYouThreads({
      shells: get(environmentThreadShells.navigationThreadShellsAtom),
      environmentId,
      now: new Date().toISOString(),
    });
    if (sameNeedsYouThreads(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`needs-you-threads:${environmentId}`));
});

// What each transcript read left behind, kept for the session: one short line per thread turn.
const useTexts = create<{ readonly texts: Readonly<Record<string, string>> }>(() => ({
  texts: {},
}));
const reading = new Set<string>();

function textOf(
  job: TextJob,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem["item"]>,
): string {
  for (const item of items.toReversed()) {
    if (job.source === "reply" && item.type === "assistant_message") {
      return pendingItems(item.text)[0] ?? "";
    }
    if (job.source === "question" && item.type === "user_input_request") {
      return item.questions[0]?.question ?? "";
    }
  }
  return "";
}

/**
 * The threads waiting on the user, longest first. The list follows the client's own thread state, so it
 * needs no polling; a transcript is read only for a thread that finished a turn or opened a question
 * since the last read, four at a time. A failed read is tried again when the thread list next changes.
 */
export function useNeedsYou(environmentId: EnvironmentId): ReadonlyArray<NeedsYouEntry> {
  const threads = useAtomValue(needsYouThreadsAtom(environmentId));
  const texts = useTexts((state) => state.texts);
  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const read = useStableCallback(async (jobs: ReadonlyArray<TextJob>) => {
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const result = await loadTranscript({
          environmentId,
          input: { threadId: ThreadId.make(job.threadId) },
        });
        reading.delete(job.key);
        if (result._tag !== "Success") continue;
        const text = textOf(
          job,
          result.value.items.map(({ item }) => item),
        );
        useTexts.setState((state) => ({ texts: { ...state.texts, [job.key]: text } }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, jobs.length) }, worker));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads transcripts from the server for threads that changed
  useEffect(() => {
    const jobs = missingTextJobs(threads, useTexts.getState().texts).filter(
      (job) => !reading.has(job.key),
    );
    for (const job of jobs) reading.add(job.key);
    if (jobs.length > 0) void read(jobs);
  }, [threads, read]);
  return buildEntries(threads, texts);
}
