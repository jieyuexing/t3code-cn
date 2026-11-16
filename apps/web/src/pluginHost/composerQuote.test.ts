import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";

import { reviewCommentContextLabel } from "~/lib/composerContextRecords";
import { isQuoteComment } from "@t3tools/shared/composerQuote";

import { addQuoteToComposer, buildQuoteComment } from "./composerQuote";

describe("plugin quote", () => {
  it("keeps title, link, source and the full selection in a review-comment-shaped item", () => {
    const quote = buildQuoteComment(
      {
        title: "Post",
        text: "line one\nline two",
        url: "https://example.com/p",
        source: "订阅 · X",
      },
      "q1",
    );
    expect(isQuoteComment(quote)).toBe(true);
    expect(quote).toMatchObject({
      id: "quote-q1",
      sectionTitle: "Post",
      filePath: "https://example.com/p",
      rangeLabel: "订阅 · X",
      diff: "line one\nline two",
      fenceLanguage: "text",
    });
    expect(reviewCommentContextLabel(quote)).toBe("Post");
  });

  it("falls back to the title where there is no link, and is not mistaken for a diff comment", () => {
    const quote = buildQuoteComment({ title: "Post", text: "x" }, "q2");
    expect(quote.filePath).toBe("Post");
    expect(quote.rangeLabel).toBe("");
    expect(isQuoteComment({ sectionId: "file:src/a.ts" })).toBe(false);
  });

  it("drops the quote into the thread's draft without sending, and says so when there is no thread", () => {
    const threadRef = scopeThreadRef(EnvironmentId.make("env-q"), ThreadId.make("thread-q"));
    addQuoteToComposer(threadRef, { title: "Post", text: "chosen", source: "订阅 · X" });
    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    expect(draft?.reviewComments).toHaveLength(1);
    expect(draft?.reviewComments[0]).toMatchObject({ sectionTitle: "Post", diff: "chosen" });
    expect(draft?.prompt).toContain("t3-context://v1/review-comment/");
    expect(() => addQuoteToComposer(null, { title: "Post", text: "x" })).toThrow(
      "No thread is open.",
    );
  });
});
