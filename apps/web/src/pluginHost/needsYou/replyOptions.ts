import { stripMarkdown } from "./replyPending";

export interface ReplyOption {
  /** 甲乙丙丁 or A–D. */
  readonly label: string;
  readonly recommended: boolean;
  /** What follows the label, without Markdown marks. */
  readonly text: string;
}

const MAX_REPLY_OPTIONS = 4;

const LABEL = "(甲|乙|丙|丁|[A-D])";
// A bold label opens the line, with or without a list mark: `**甲**`, `- **方案甲：…**`.
const BOLD_OPTION = new RegExp(
  `^\\s*(?:[-*+•]|\\d+[.)、])?\\s*(?:\\*\\*|__)\\s*(?:选项|方案)?\\s*${LABEL}(?![A-Za-z0-9])`,
);
// A plain label needs a list mark and a separator after it: `1. 甲：…`, `- 选项 A.`.
const LISTED_OPTION = new RegExp(
  `^\\s*(?:[-*+•]|\\d+[.)、])\\s*(?:选项|方案)?\\s*${LABEL}\\s*(?:[.．、:：]|(?=[（(]))`,
);
const RECOMMENDED = /(?<![不非])推荐/;

/**
 * The labelled options of a reply, the recommended one first and at most four. A label that shows
 * up twice means the reply holds more than one group of options and the labels cannot be told
 * apart, so the answer is "multi". Fewer than two options is an empty list.
 */
export function replyOptions(reply: string): ReadonlyArray<ReplyOption> | "multi" {
  const found: ReplyOption[] = [];
  let repeated = false;
  for (const line of reply.split(/\r?\n/)) {
    const match = BOLD_OPTION.exec(line) ?? LISTED_OPTION.exec(line);
    if (match === null) continue;
    const label = match[1]!;
    repeated ||= found.some((option) => option.label === label);
    const text = stripMarkdown(line.slice(match[0].length))
      .replace(/^[.．、:：]\s*/, "")
      .replace(/^([（(]推荐[）)])\s*[:：]\s*/, "$1");
    found.push({ label, recommended: RECOMMENDED.test(text), text });
  }
  if (repeated) return new Set(found.map((option) => option.label)).size >= 2 ? "multi" : [];
  if (found.length < 2) return [];
  return [
    ...found.filter((option) => option.recommended),
    ...found.filter((option) => !option.recommended),
  ].slice(0, MAX_REPLY_OPTIONS);
}
