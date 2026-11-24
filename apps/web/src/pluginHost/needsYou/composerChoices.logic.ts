import type { OrchestrationV2ProjectedTurnItem, RunId } from "@t3tools/contracts";

import { FOLLOW_RECOMMENDATION } from "./needsYou.logic";
import { replyOptions } from "./replyOptions";
import type { PromptAdvisorItem, PromptAdvisorKind } from "./promptAdvisorPayload.cn";
import { pendingItems } from "./replyPending";

export interface ComposerChoice {
  /** What lands in the composer. */
  readonly fill: string;
  /** The label next to the button text; empty for the follow-the-recommendation button. */
  readonly detail: string;
  /** Absent on a button read from the reply's own options. */
  readonly source?: "rule" | "advisor";
  readonly kind?: PromptAdvisorKind;
  /** The advisor's caption for the button. */
  readonly label?: string;
  /** The advisor kind's tag shown before the caption. */
  readonly badge?: string;
}

/** The buttons for one reply: its options and 按推荐, or 按推荐 alone when the labels cannot be told apart or only 待你定 is there. */
export function composerChoices(reply: string): ReadonlyArray<ComposerChoice> {
  const options = replyOptions(reply);
  const follow: ComposerChoice = { fill: FOLLOW_RECOMMENDATION, detail: "" };
  if (options !== "multi" && options.length >= 2) {
    return [...options.map((option) => ({ fill: option.label, detail: option.text })), follow];
  }
  return options === "multi" || pendingItems(reply).length > 0 ? [follow] : [];
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;
const BADGES: Record<PromptAdvisorKind, { readonly zh: string; readonly en: string }> = {
  challenge: { zh: "反问", en: "Challenge" },
  next: { zh: "推进", en: "Next" },
  angle: { zh: "换角度", en: "Angle" },
};
const BESIDE_RULES: Record<"challenge" | "angle", { readonly zh: string; readonly en: string }> = {
  challenge: { zh: "盲点", en: "Blind spot" },
  angle: { zh: "换角度", en: "Angle" },
};

function advisorChoice(item: PromptAdvisorItem, beside: boolean): ComposerChoice {
  const badges = beside && item.kind !== "next" ? BESIDE_RULES[item.kind] : BADGES[item.kind];
  return {
    source: "advisor",
    kind: item.kind,
    badge: CJK.test(item.fill) ? badges.zh : badges.en,
    label: item.label,
    fill: item.fill,
    detail: "",
  };
}

const MERGE_COPY = {
  zh: {
    badge: "全部",
    label: (count: number) => `合并 ${count} 条`,
    header: "请逐条回应以下几点：",
  },
  en: {
    badge: "All",
    label: (count: number) => `Merge ${count}`,
    header: "Please respond to each point:",
  },
} as const;

/** Combine multiple advisor prompts into one numbered follow-up message. */
function mergedAdvisorFill(items: ReadonlyArray<PromptAdvisorItem>, header: string): string {
  return [header, ...items.map((item, index) => `${index + 1}. ${item.fill}`)].join("\n");
}

/**
 * The reply's own buttons, shown at once, with the context advisor's suggestions: one blind-spot
 * or angle button beside rule buttons, all of them when the reply held no options (plus a trailing
 * merge chip when 2+ advisor items appear alone).
 */
export function mergeComposerChoices(
  reply: string,
  advisorItems: ReadonlyArray<PromptAdvisorItem>,
): ReadonlyArray<ComposerChoice> {
  const rules = composerChoices(reply);
  if (rules.length === 0) {
    const advisors = advisorItems.map((item) => advisorChoice(item, false));
    if (advisors.length < 2) return advisors;
    const copy = advisorItems.some((item) => CJK.test(item.fill)) ? MERGE_COPY.zh : MERGE_COPY.en;
    return [
      ...advisors,
      {
        source: "advisor",
        badge: copy.badge,
        label: copy.label(advisors.length),
        fill: mergedAdvisorFill(advisorItems, copy.header),
        detail: "",
      },
    ];
  }
  const extra =
    advisorItems.find((item) => item.kind === "challenge") ??
    advisorItems.find((item) => item.kind === "angle");
  return extra === undefined ? rules : [...rules, advisorChoice(extra, true)];
}

/** The item of the run's last assistant message that is not a commentary line, or undefined. */
export function lastAnswerItem(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runId: RunId,
) {
  for (const { item, visibility } of rows.toReversed()) {
    if (
      visibility === "local" &&
      item.type === "assistant_message" &&
      item.runId === runId &&
      item.phase !== "commentary"
    ) {
      return item;
    }
  }
  return undefined;
}
