import type { ScopedThreadRef } from "@t3tools/contracts";
import { quoteSectionId } from "@t3tools/shared/composerQuote";

import { useComposerDraftStore } from "../composerDraftStore";
import { randomUUID } from "~/lib/utils";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { BridgeCallError } from "./bridge";

export interface PluginQuote {
  readonly title: string;
  readonly text: string;
  readonly url?: string;
  readonly source?: string;
}

export function buildQuoteComment(quote: PluginQuote, id: string): ReviewCommentContext {
  return {
    id: `quote-${id}`,
    sectionId: quoteSectionId(id),
    sectionTitle: quote.title,
    filePath: quote.url ?? quote.title,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: quote.source ?? "",
    text: "",
    diff: quote.text,
    fenceLanguage: "text",
  };
}

/** Puts a quote in the thread's draft and never sends it; the draft store ignores a thread it cannot resolve, so the result is read back. */
export function addQuoteToComposer(threadRef: ScopedThreadRef | null, quote: PluginQuote): void {
  if (threadRef === null) {
    throw new BridgeCallError({ code: "call-failed", message: "No thread is open." });
  }
  const comment = buildQuoteComment(quote, randomUUID());
  const store = useComposerDraftStore.getState();
  store.addReviewComment(threadRef, comment);
  if (!store.getComposerDraft(threadRef)?.reviewComments.some(({ id }) => id === comment.id)) {
    throw new BridgeCallError({ code: "call-failed", message: "The composer did not take it." });
  }
}
