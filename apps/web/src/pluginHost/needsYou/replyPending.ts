const HEADING = /^\s*(#{1,6})?\s*(?:\*\*|__)?\s*待你定\s*[:：]?\s*(?:\*\*|__)?\s*[:：]?\s*$/;
// 标题和正文写在同一行：`**待你定**：要不要合并？`
const INLINE_HEADING =
  /^\s*(#{1,6})?\s*(?:\*\*|__)?\s*待你定\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(\S.*)$/;
// 不写标题、用一句话引出列表：`剩下的要你来定，我先不动：`
const LEAD_IN =
  /^\s*(?!(?:\d+[.)、]|[-*+•>#])\s)[^\n]*(?:待|要|等|需要)你来?定[^。！？!?]*[:：]\s*$/;
const ANY_HEADING = /^\s{0,3}(#{1,6})\s/;
const BOLD_LINE = /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*[:：]?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)(?:\d+[.)、]|[-*+•])\s+(.*)$/;

export function stripMarkdown(line: string): string {
  return line
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[，。,.;；:：!！?？])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** 最后一个「待你定」标题之后、下一个同级或更高标题（或别的独立粗体行、分隔线）之前的行；标题后同一行有正文时，只有这一行。 */
function sectionOf(lines: string[]): string[] | null {
  let start = -1;
  let level = 0;
  let inline = "";
  lines.forEach((line, index) => {
    const match = HEADING.exec(line) ?? (LEAD_IN.test(line) ? [line] : null);
    const same = match === null ? INLINE_HEADING.exec(line) : null;
    const found = match ?? same;
    if (found === null) return;
    start = index;
    level = found[1]?.length ?? 0;
    inline = same?.[2] ?? "";
  });
  if (start < 0) return null;
  if (inline !== "") return [inline];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = ANY_HEADING.exec(line);
    if (heading !== null && (level === 0 || heading[1]!.length <= level)) break;
    if (level === 0 && BOLD_LINE.test(line)) break;
    if (RULE.test(line)) break;
    body.push(line);
  }
  return body;
}

/** 回复里「待你定」段的条目文字；没有这一段、或段里没有内容，返回空数组。 */
export function pendingItems(reply: string): string[] {
  const section = sectionOf(reply.split(/\r?\n/));
  if (section === null) return [];
  const entries = section.flatMap((line) => {
    const match = LIST_ITEM.exec(line);
    return match === null
      ? []
      : [{ indent: match[1]!.replace(/\t/g, "    ").length, text: match[2]! }];
  });
  if (entries.length > 0) {
    const top = Math.min(...entries.map((entry) => entry.indent));
    return entries
      .filter((entry) => entry.indent === top)
      .map((entry) => stripMarkdown(entry.text))
      .filter((text) => text !== "");
  }
  const text = stripMarkdown(
    section
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(0, 2)
      .join(" "),
  );
  return text === "" ? [] : [text];
}
