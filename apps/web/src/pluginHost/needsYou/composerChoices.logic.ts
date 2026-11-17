import type { OrchestrationV2ProjectedTurnItem, RunId } from "@t3tools/contracts";

import { followRecommendationFor } from "./needsYou.logic";
import { replyOptions } from "./replyOptions";
import { pendingItems } from "./replyPending";

export interface ComposerChoice {
  /** What lands in the composer. */
  readonly fill: string;
  /** The label next to the button text; empty for the follow-the-recommendation button. */
  readonly detail: string;
}

/** The buttons for one reply: its options and 按推荐, or the follow-the-recommendation button alone when the labels cannot be told apart or only 待你定 is there. */
export function composerChoices(reply: string): ReadonlyArray<ComposerChoice> {
  const options = replyOptions(reply);
  const follow: ComposerChoice = { fill: followRecommendationFor(reply), detail: "" };
  if (options !== "multi" && options.length >= 2) {
    return [...options.map((option) => ({ fill: option.label, detail: option.text })), follow];
  }
  return options === "multi" || pendingItems(reply).length > 0 ? [follow] : [];
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
