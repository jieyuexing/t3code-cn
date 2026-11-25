import type { EnvironmentId, OrchestrationV2Run, ScopedThreadRef } from "@t3tools/contracts";
import { announcedRun } from "@t3tools/client-runtime/state/thread-activity-announcement";
import { useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import {
  useAssistantMessageText,
  useServerConfigs,
  useTimelineVisibleTurnItems,
} from "~/state/entities";
import type { Thread } from "~/types";

import { dismissChoices, useChoicesDismissed } from "./composerChoiceDismissal";
import {
  formatAdvisorSelection,
  isAdvisorItemChoice,
  lastAnswerItem,
  mergeComposerChoices,
  type ComposerChoice,
} from "./composerChoices.logic";
import { parsePromptAdvisorPayload } from "./promptAdvisorPayload.cn";

interface AdvisorSelectionState {
  readonly key: string;
  readonly indices: ReadonlyArray<number>;
  readonly generatedText: string;
}

const EMPTY_INDICES: ReadonlyArray<number> = [];
const EMPTY_SELECTION: AdvisorSelectionState = {
  key: "",
  indices: EMPTY_INDICES,
  generatedText: "",
};

export interface ComposerChoicesController {
  readonly choices: ReadonlyArray<ComposerChoice>;
  readonly visible: boolean;
  readonly selectedAdvisorIndices: ReadonlyArray<number>;
  readonly toggleAdvisor: (index: number) => string;
  readonly toggleAllAdvisors: () => string;
  readonly selectFirstAdvisor: () => string;
  readonly dismiss: () => void;
  readonly resetSelection: () => void;
}

/**
 * The buttons for the thread's latest reply while its run is done and the next-step suggestions
 * setting is on; empty after Esc on this run. Advisor buttons support toggling multiple items and
 * stay visible as long as the composer text still matches the generated preview (or is empty).
 */
export function useComposerChoices(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
  runs: ReadonlyArray<OrchestrationV2Run>,
  threadRef: ScopedThreadRef,
  promptSuggestion: string | null,
  prompt: string,
): ComposerChoicesController {
  const enabled = useServerConfigs().get(environmentId)?.settings.promptSuggestionsEnabled === true;
  const run = announcedRun(thread?.latestRun ?? null, runs);
  const runId = run?.status === "completed" ? run.runId : null;
  const dismissed = useChoicesDismissed(environmentId, runId);
  // Reading the text only once the run is done keeps streaming from re-rendering the composer.
  const open = enabled && runId !== null && !dismissed ? threadRef : null;
  const rows = useTimelineVisibleTurnItems(open);
  const answerId = open === null || runId === null ? undefined : lastAnswerItem(rows, runId)?.id;
  const text = useAssistantMessageText(open, answerId);
  const advisorItems = parsePromptAdvisorPayload(promptSuggestion) ?? [];
  const choices = text === null ? [] : mergeComposerChoices(text, advisorItems);
  const advisorChoices = choices.filter(isAdvisorItemChoice);

  const [selection, setSelection] = useState<AdvisorSelectionState>(EMPTY_SELECTION);
  const selectionKey =
    runId === null
      ? ""
      : `${environmentId}\u0000${threadRef.threadId}\u0000${runId}\u0000${promptSuggestion ?? ""}`;
  const activeSelection =
    selection.key === selectionKey &&
    selection.indices.length > 0 &&
    prompt === selection.generatedText
      ? selection.indices.filter((index) => index >= 0 && index < advisorChoices.length)
      : EMPTY_INDICES;

  const commitSelection = (nextIndices: ReadonlyArray<number>): string => {
    const valid = nextIndices.filter((index) => index >= 0 && index < advisorChoices.length);
    const nextText = formatAdvisorSelection(valid.map((index) => advisorChoices[index]!));
    setSelection({ key: selectionKey, indices: valid, generatedText: nextText });
    return nextText;
  };

  const resetSelection = useStableCallback(() => {
    setSelection((current) => (current.indices.length === 0 ? current : EMPTY_SELECTION));
  });

  return {
    choices,
    visible: choices.length > 0 && (prompt.length === 0 || activeSelection.length > 0),
    selectedAdvisorIndices: activeSelection,
    toggleAdvisor: (index) =>
      commitSelection(
        activeSelection.includes(index)
          ? activeSelection.filter((item) => item !== index)
          : [...activeSelection, index].toSorted((a, b) => a - b),
      ),
    toggleAllAdvisors: () =>
      commitSelection(
        activeSelection.length === advisorChoices.length
          ? EMPTY_INDICES
          : advisorChoices.map((_, index) => index),
      ),
    selectFirstAdvisor: () => commitSelection(advisorChoices.length > 0 ? [0] : EMPTY_INDICES),
    dismiss: () => {
      resetSelection();
      if (runId !== null) dismissChoices(environmentId, runId);
    },
    resetSelection,
  };
}
