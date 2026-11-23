const PROMPT_REFINE_PATH = "/prompt-refine";
/** The fork-only route family the refiner's HTTP base path points at. */
export const PROMPT_REFINE_BASE_PATH = "/api/cn";

export type PromptRefineMode = "structured" | "bold" | "scoped";
export const DEFAULT_REFINE_MODE: PromptRefineMode = "structured";

/* oxlint-disable t3code/no-untranslated-copy -- the refiner is fork-only Chinese copy, outside the catalogs */
export const PROMPT_REFINE_MODE_META: ReadonlyArray<{
  readonly mode: PromptRefineMode;
  readonly label: string;
  readonly hint: string;
}> = [
  { mode: "structured", label: "结构清晰", hint: "理清目标、维度、边界与期望输出" },
  { mode: "bold", label: "大胆发散", hint: "放大锋芒，逼出相互冲突的激进视角" },
  { mode: "scoped", label: "工程交付", hint: "补齐范围、不做什么与验收标准" },
];
/* oxlint-enable t3code/no-untranslated-copy */

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

/* oxlint-disable t3code/no-untranslated-copy -- fork-only Chinese copy, outside the catalogs */
export const PROMPT_REFINER_COPY = {
  region: "提示词优化",
  loading: "正在优化提示词…",
  apply: "应用替换",
  cancel: "取消",
  retry: "重试",
  undo: "撤销优化",
  withContext: "已附带仓库上下文",
  draftChanged: "草稿已改动",
  selectionChanged: "选区内容已改动，请重新选择后再优化。",
  replaceRefused: "草稿已改动，没能替换，请重新优化。",
  failed: "优化失败，请重试。",
  tooltip: (shortcut: string) => `优化提示词 (${shortcut})`,
} as const;

export function refineFailureMessage(status: number): string {
  switch (status) {
    case 503:
      return "当前没有可用的提示词顾问（需要已登录的 Antigravity）。";
    case 502:
      return "优化超时或失败了，请重试。";
    case 401:
      return "登录已失效，请重新连接后再试。";
    case 403:
      return "当前会话没有使用该功能的权限。";
    case 400:
      return "草稿或选区不符合要求，请调整后再试。";
    default:
      return `优化失败（${status}）。`;
  }
}
/* oxlint-enable t3code/no-untranslated-copy */

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
