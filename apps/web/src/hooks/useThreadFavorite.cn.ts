import { type ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { readEnvironmentSupportsAutoSettleOptOut } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export const FAVORITE_THREAD_TAG = "cn:favorite";

type FavoriteTagInput = {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
};

export function isThreadFavorited(thread: FavoriteTagInput): boolean {
  const tags = thread.tags ?? thread.source?.tags;
  return tags?.includes(FAVORITE_THREAD_TAG) === true;
}

export function favoriteThreadErrorTitle(favorited: boolean): string {
  return favorited ? m(msg("Failed to favorite thread")) : m(msg("Failed to unfavorite thread"));
}

export function useThreadFavorite() {
  const setThreadTag = useOrchestrationCommand(threadEnvironment.setTag, { reportFailure: false });
  const setThreadAutoSettle = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });

  return async (target: ScopedThreadRef, favorited: boolean) => {
    const tagResult = await setThreadTag({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        tag: FAVORITE_THREAD_TAG,
        tagged: favorited,
      },
    });
    if (tagResult._tag === "Failure") {
      return tagResult;
    }
    if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
      return tagResult;
    }
    return setThreadAutoSettle({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        enabled: !favorited,
      },
    });
  };
}
