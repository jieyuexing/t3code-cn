import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { isMacPlatform } from "~/lib/utils";

import { requestPromptRefine } from "./promptRefinerClient";
import {
  canRefine,
  DEFAULT_REFINE_MODE,
  isRefineShortcut,
  normalizeSelection,
  planApply,
  planUndo,
  PROMPT_REFINER_COPY,
  type PromptApplyPlan,
  type PromptRefineMode,
  type PromptRefineResult,
  type PromptRefineSelection,
  type PromptRefineSnapshot,
  type PromptReplacement,
} from "./promptRefiner.logic";

export type PromptRefinerState =
  | { readonly status: "idle" }
  | {
      readonly status: "loading";
      readonly mode: PromptRefineMode;
      readonly snapshot: PromptRefineSnapshot;
    }
  | {
      readonly status: "preview";
      readonly mode: PromptRefineMode;
      readonly snapshot: PromptRefineSnapshot;
      readonly result: PromptRefineResult;
    }
  | {
      readonly status: "error";
      readonly mode: PromptRefineMode;
      readonly snapshot: PromptRefineSnapshot;
      readonly message: string;
    };

interface AppliedRefinement {
  readonly undo: PromptReplacement;
  /** The whole draft right after applying; the undo offer ends with the next edit. */
  readonly appliedText: string;
}

/**
 * The refiner's state machine: ask with a snapshot of the draft, show the answer, replace on
 * confirmation and offer one undo. The draft is never sent or replaced without the user's click.
 */
export function usePromptRefiner(options: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly prompt: string;
  readonly disabled: boolean;
  readonly readDraft: () => {
    readonly text: string;
    readonly selection: PromptRefineSelection | undefined;
  };
  readonly replaceRange: (replacement: PromptReplacement) => boolean;
}) {
  const { environmentId, projectId, threadId, prompt, disabled, readDraft, replaceRange } = options;
  const [state, setState] = useState<PromptRefinerState>({ status: "idle" });
  const [lastMode, setLastMode] = useState<PromptRefineMode>(DEFAULT_REFINE_MODE);
  const [applied, setApplied] = useState<AppliedRefinement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ status: "idle" });
  };

  const run = (snapshot: PromptRefineSnapshot, mode: PromptRefineMode) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLastMode(mode);
    setApplied(null);
    setState({ status: "loading", mode, snapshot });
    requestPromptRefine(
      environmentId,
      { draft: snapshot.draft, selection: snapshot.selection, mode, projectId, threadId },
      controller.signal,
    ).then(
      (outcome) => {
        if (controller.signal.aborted) return;
        setState(
          outcome.ok
            ? { status: "preview", mode, snapshot, result: outcome.result }
            : { status: "error", mode, snapshot, message: outcome.message },
        );
      },
      () => {
        if (!controller.signal.aborted) {
          setState({ status: "error", mode, snapshot, message: PROMPT_REFINER_COPY.failed });
        }
      },
    );
  };

  const start = () => {
    if (!canRefine(prompt, disabled)) return;
    const draft = readDraft();
    run(
      { draft: draft.text, selection: normalizeSelection(draft.text, draft.selection) },
      lastMode,
    );
  };

  const selectMode = (mode: PromptRefineMode) => {
    if (state.status !== "idle") run(state.snapshot, mode);
  };

  const apply = () => {
    if (state.status !== "preview") return;
    const current = readDraft().text;
    const plan: PromptApplyPlan = planApply(state.snapshot, current, state.result.refined);
    if (plan.kind === "selection-changed") {
      setState({ ...state, status: "error", message: PROMPT_REFINER_COPY.selectionChanged });
      return;
    }
    if (!replaceRange(plan)) {
      setState({ ...state, status: "error", message: PROMPT_REFINER_COPY.replaceRefused });
      return;
    }
    setApplied({
      undo: planUndo(plan),
      appliedText: `${current.slice(0, plan.start)}${plan.replacement}${current.slice(plan.end)}`,
    });
    setState({ status: "idle" });
  };

  const undoAvailable = applied !== null && prompt === applied.appliedText;
  const undo = () => {
    if (applied === null || !undoAvailable) return;
    replaceRange(applied.undo);
    setApplied(null);
  };

  const active = state.status !== "idle";
  const startStable = useStableCallback(start);
  const cancelStable = useStableCallback(cancel);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the editor handles keys before React, so the shortcut and Esc listen on the document first
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        target.isContentEditable &&
        target.closest("[data-chat-composer-form]") !== null;
      if (!typing || event.isComposing || event.keyCode === 229) return;
      if (isRefineShortcut(event, isMacPlatform(navigator.platform))) startStable();
      else if (event.key === "Escape" && active) cancelStable();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, startStable, cancelStable]);

  return {
    state,
    mode: lastMode,
    canStart: canRefine(prompt, disabled),
    undoAvailable,
    start,
    cancel,
    selectMode,
    apply,
    undo,
  };
}
