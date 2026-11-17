import type { EnvironmentId, OrchestrationV2Run, ScopedThreadRef } from "@t3tools/contracts";
import { announcedRun } from "@t3tools/client-runtime/state/thread-activity-announcement";

import {
  useAssistantMessageText,
  useServerConfigs,
  useTimelineVisibleTurnItems,
} from "~/state/entities";
import type { Thread } from "~/types";

import { dismissChoices, useChoicesDismissed } from "./composerChoiceDismissal";
import { composerChoices, lastAnswerItem, type ComposerChoice } from "./composerChoices.logic";

/**
 * The buttons for the thread's latest reply while its run is done and the next-step suggestions
 * setting is on; empty after Esc on this run. Only the reply's text is read, no model call.
 */
export function useComposerChoices(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
  threadRef: ScopedThreadRef,
): { readonly choices: ReadonlyArray<ComposerChoice>; readonly dismiss: () => void } {
  const enabled = useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  const run = announcedRun(thread?.latestRun ?? null, runs);
  const runId = run?.status === "completed" ? run.runId : null;
  const dismissed = useChoicesDismissed(environmentId, runId);
  // Reading the text only once the run is done keeps streaming from re-rendering the composer.
  const open = enabled && runId !== null && !dismissed ? threadRef : null;
  const rows = useTimelineVisibleTurnItems(open);
  const answerId = open === null || runId === null ? undefined : lastAnswerItem(rows, runId)?.id;
  const text = useAssistantMessageText(open, answerId);
  return {
    choices: text === null ? [] : composerChoices(text),
    dismiss: () => {
      if (runId !== null) dismissChoices(environmentId, runId);
    },
  };
}
