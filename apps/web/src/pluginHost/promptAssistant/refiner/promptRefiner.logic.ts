import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

const PROMPT_REFINE_PATH = "/prompt-refine";
/** The fork-only route family the refiner's HTTP base path points at. */
export const PROMPT_REFINE_BASE_PATH = "/api/cn";

export type PromptRefineMode = "structured" | "bold" | "scoped";
export const DEFAULT_REFINE_MODE: PromptRefineMode = "structured";

export const PROMPT_REFINE_MODE_META: ReadonlyArray<{
  readonly mode: PromptRefineMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    mode: "structured",
    label: msg("Structured", { $context: "prompt refine mode" }),
    hint: msg("Clarify goals, dimensions, boundaries, and expected output"),
  },
  {
    mode: "bold",
    label: msg("Divergent", { $context: "prompt refine mode" }),
    hint: msg("Sharpen your stance and surface bold, conflicting angles"),
  },
  {
    mode: "scoped",
    label: msg("Scoped", { $context: "prompt refine mode" }),
    hint: msg("Specify scope, non-goals, and acceptance criteria"),
  },
];

export interface PromptRefineSelection {
  readonly start: number;
  readonly end: number;
}

export interface PromptRefineResult {
  readonly refined: string;
  readonly mode: PromptRefineMode;
  readonly usedWorkspaceContext: boolean;
}

/** What the draft looked like when the user asked, so a late answer lands where it was meant. */
export interface PromptRefineSnapshot {
  readonly draft: string;
  readonly selection: PromptRefineSelection | undefined;
}

export interface PromptReplacement {
  readonly start: number;
  readonly end: number;
  readonly expectedText: string;
  readonly replacement: string;
}

export const canRefine = (draft: string, disabled: boolean): boolean =>
  !disabled && draft.trim().length > 0;

/** The selection when it spans text inside the draft; a caret or a stale range is no selection. */
export const normalizeSelection = (
  draft: string,
  selection: PromptRefineSelection | undefined,
): PromptRefineSelection | undefined =>
  selection !== undefined &&
  0 <= selection.start &&
  selection.start < selection.end &&
  selection.end <= draft.length
    ? { start: selection.start, end: selection.end }
    : undefined;

export function buildRefineRequest(input: {
  readonly draft: string;
  readonly selection: PromptRefineSelection | undefined;
  readonly mode: PromptRefineMode;
  readonly projectId: string | null;
  readonly threadId: string | null;
}) {
  const selection = normalizeSelection(input.draft, input.selection);
  return {
    draft: input.draft,
    mode: input.mode,
    ...(selection === undefined ? {} : { selection }),
    ...(input.projectId === null ? {} : { projectId: input.projectId }),
    ...(input.threadId === null ? {} : { threadId: input.threadId }),
  };
}

export function applyRefinedText(
  draft: string,
  selection: PromptRefineSelection | undefined,
  refined: string,
): { readonly text: string; readonly start: number; readonly end: number } {
  const range = normalizeSelection(draft, selection) ?? { start: 0, end: draft.length };
  return {
    text: `${draft.slice(0, range.start)}${refined}${draft.slice(range.end)}`,
    start: range.start,
    end: range.start + refined.length,
  };
}

export type PromptApplyPlan =
  | ({ readonly kind: "replace"; readonly original: string } & PromptReplacement)
  | { readonly kind: "selection-changed" };

/** A selection answer only replaces the text still there; a whole-draft answer takes the draft as it is now. */
export function planApply(
  snapshot: PromptRefineSnapshot,
  currentDraft: string,
  refined: string,
): PromptApplyPlan {
  const selection = normalizeSelection(snapshot.draft, snapshot.selection);
  if (selection === undefined) {
    return {
      kind: "replace",
      start: 0,
      end: currentDraft.length,
      expectedText: currentDraft,
      replacement: refined,
      original: currentDraft,
    };
  }
  const original = snapshot.draft.slice(selection.start, selection.end);
  return currentDraft.slice(selection.start, selection.end) === original
    ? {
        kind: "replace",
        start: selection.start,
        end: selection.end,
        expectedText: original,
        replacement: refined,
        original,
      }
    : { kind: "selection-changed" };
}

export const planUndo = (
  plan: Extract<PromptApplyPlan, { kind: "replace" }>,
): PromptReplacement => ({
  start: plan.start,
  end: plan.start + plan.replacement.length,
  expectedText: plan.replacement,
  replacement: plan.original,
});

const isMode = (value: unknown): value is PromptRefineMode =>
  PROMPT_REFINE_MODE_META.some((entry) => entry.mode === value);

export function parseRefineResponse(value: unknown): PromptRefineResult | null {
  if (typeof value !== "object" || value === null) return null;
  const { refined, mode, usedWorkspaceContext } = value as Record<string, unknown>;
  return typeof refined === "string" &&
    refined.length > 0 &&
    isMode(mode) &&
    typeof usedWorkspaceContext === "boolean"
    ? { refined, mode, usedWorkspaceContext }
    : null;
}

export const PROMPT_REFINER_COPY = {
  region: msg("Prompt Refiner"),
  loading: msg("Refining prompt…"),
  apply: msg("Apply", { $context: "prompt refiner button" }),
  cancel: msg("Cancel"),
  retry: msg("Retry"),
  undo: msg("Undo", { $context: "prompt refiner button" }),
  withContext: msg("Workspace context attached"),
  draftChanged: msg("Draft changed"),
  selectionChanged: msg("Selection changed; select again and retry."),
  replaceRefused: msg("Draft changed and could not be replaced; refine again."),
  failed: msg("Refinement failed. Try again."),
  tooltip: (shortcut: string, resolve: MessageResolver = m) =>
    resolve(msg("Refine prompt ({shortcut})", { shortcut })),
} as const;

export function refineFailureMessage(status: number, resolve: MessageResolver = m): string {
  switch (status) {
    case 503:
      return resolve(
        msg("No prompt advisor available (requires a signed-in Antigravity account)."),
      );
    case 502:
      return resolve(msg("Refinement timed out or failed. Try again."));
    case 401:
      return resolve(msg("Session expired. Reconnect and try again."));
    case 403:
      return resolve(msg("This session does not have permission to refine prompts."));
    case 400:
      return resolve(msg("Draft or selection is invalid. Adjust and try again."));
    default:
      return resolve(msg("Refinement failed ({status}).", { status }));
  }
}

export const refineUrl = (access: {
  readonly httpBase: string;
  readonly query: Readonly<Record<string, string>>;
}): string => {
  const search = new URLSearchParams(Object.entries(access.query)).toString();
  return `${access.httpBase}${PROMPT_REFINE_PATH}${search === "" ? "" : `?${search}`}`;
};

// Not E: mod+shift+e is the composer.effort default.
export const isRefineShortcut = (event: KeyboardEvent, isMac: boolean): boolean =>
  event.key.toLowerCase() === "y" &&
  event.shiftKey &&
  !event.altKey &&
  (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
