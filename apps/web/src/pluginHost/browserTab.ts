import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { canOpenLinksInApp } from "../browser/browserLinkTarget";
import {
  isBrowserSettingsReadError,
  openUrlInPreview,
  type OpenPreviewMutation,
} from "../browser/openFileInPreview";
import { recordVisitForThread } from "../browserHistoryStore";
import { readThreadPreviewState } from "../previewStateStore";
import { rightPanelHostRef } from "../rightPanelStore";
import { BridgeCallError } from "./bridge";

/**
 * Opens a page as a tab of the thread's T3 browser; a plugin view's `browser.open` and a rail web app
 * share it. A foreground open returns the id of the tab now showing.
 */
export async function openBrowserTab<E>(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly url: string;
  readonly profileId?: string;
  readonly background: boolean;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<string | null> {
  const { threadRef, url, profileId, background, openPreview } = input;
  if (threadRef === null || !canOpenLinksInApp(threadRef)) {
    throw new BridgeCallError({
      code: "call-failed",
      message: "The browser is unavailable in this thread.",
    });
  }
  const result = await openUrlInPreview({
    threadRef,
    url,
    openPreview,
    background,
    ...(profileId === undefined ? {} : { profileId }),
  });
  if (result._tag !== "Success") {
    const error = squashAtomCommandFailure(result);
    throw new BridgeCallError({
      code: isAtomCommandInterrupted(result) ? "cancelled" : "call-failed",
      message: isBrowserSettingsReadError(error)
        ? "The saved browser settings could not be loaded."
        : error instanceof Error
          ? error.message
          : "The browser could not open the page.",
    });
  }
  recordVisitForThread(threadRef, url);
  return background ? null : readThreadPreviewState(rightPanelHostRef(threadRef)).activeTabId;
}
