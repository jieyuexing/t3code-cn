import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  type ReviewCommentContextRecord,
} from "@t3tools/contracts";

/**
 * A plugin's quote rides the review-comment item so drafts, sending and chips need no new kind:
 * `sectionTitle` is the title, `filePath` the link (the title when there is none), `rangeLabel`
 * the source, and `diff` the selection as plain text.
 */
const QUOTE_SECTION_PREFIX = "quote:";

export const QUOTE_TEXT_MAX_CHARS = COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS;
export const QUOTE_TITLE_MAX_CHARS = COMPOSER_CONTEXT_LABEL_MAX_CHARS;

export const quoteSectionId = (id: string) => `${QUOTE_SECTION_PREFIX}${id}`;

export const isQuoteComment = (comment: { readonly sectionId: string }) =>
  comment.sectionId.startsWith(QUOTE_SECTION_PREFIX);

/** The kind the agent sees, so a quote is not presented to it as a code review comment. */
export const providerContextKind = (
  kind: string,
  record: { readonly kind: string; readonly sectionId?: string } | undefined,
): string =>
  record?.kind === "review-comment" &&
  record.sectionId !== undefined &&
  isQuoteComment({ sectionId: record.sectionId })
    ? "web-quote"
    : kind;

/** What the agent reads in place of a review comment's file and range lines. */
export function formatQuoteForProvider(
  record: Pick<ReviewCommentContextRecord, "sectionTitle" | "filePath" | "rangeLabel" | "diff">,
): string {
  const lines = [`title: ${record.sectionTitle}`];
  if (record.filePath !== record.sectionTitle) lines.push(`url: ${record.filePath}`);
  if (record.rangeLabel !== "") lines.push(`source: ${record.rangeLabel}`);
  lines.push(
    "quote:",
    ...record.diff
      .replace(/\n+$/, "")
      .split("\n")
      .map((line) => `  ${line}`),
  );
  return lines.join("\n");
}
