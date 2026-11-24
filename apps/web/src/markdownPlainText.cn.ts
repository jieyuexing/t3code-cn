import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/assistantInsights";
import { toHtml } from "hast-util-to-html";

import { serializeCodeBlockToMarkdown } from "./markdown-clipboard";
import { renderCodexDirectivesForCopy } from "./markdown/markdownText";
import { wordsHast } from "./markdown/wordsHast";

const CODE_BOUNDARY = "\u0000";
const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);
const SKIPPED_CLASS_NAMES = ["select-none", "sr-only"];
const LIST_ITEM_CHECKBOX = ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]';
const COMPOSER_CONTEXT_LINK_MARKER = "(t3-context://v1/";

const BLOCK_ELEMENT_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "DL",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

const ALERT_TITLES: Readonly<Record<string, string>> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
  insight: "Insight",
};

const EMPTY_EXTENSIONS = {};

type ContainerKind = "block" | "inline" | "list-item";

export function isComposerContextMarkdownCopy(value: string): boolean {
  return value.includes(COMPOSER_CONTEXT_LINK_MARKER);
}

function verbatimBlock(code: string): string {
  return `${CODE_BOUNDARY}${code}${CODE_BOUNDARY}\n\n`;
}

function outsideCode(text: string, transform: (prose: string) => string): string {
  return text
    .split(CODE_BOUNDARY)
    .map((part, index) =>
      index % 2 === 1 ? `${CODE_BOUNDARY}${part}${CODE_BOUNDARY}` : transform(part),
    )
    .join("");
}

function tidyPlainText(text: string): string {
  const parts = text.split(CODE_BOUNDARY);
  const last = parts.length - 1;
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let prose = part.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n");
      if (index === 0) prose = prose.trimStart();
      if (index === last) prose = prose.trimEnd();
      return prose;
    })
    .join("");
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

function isBlockDomNode(node: Node | null): boolean {
  return node?.nodeType === Node.ELEMENT_NODE && BLOCK_ELEMENT_TAGS.has((node as Element).tagName);
}

function numberedListItems(list: Element): { item: Element; number: number }[] {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  let next = Number.isNaN(start) ? 1 : start;
  return [...list.children]
    .filter((child) => child.tagName === "LI")
    .map((item) => {
      const value = Number.parseInt(item.getAttribute("value") ?? "", 10);
      if (!Number.isNaN(value)) next = value;
      return { item, number: next++ };
    });
}

function serializePlainListItem(item: Element, ordered: boolean, index: number): string {
  const checkbox = item.querySelector<HTMLInputElement>(LIST_ITEM_CHECKBOX);
  const task = checkbox ? (checkbox.checked ? "☑ " : "☐ ") : "";
  const bullet = ordered ? `${index}. ` : "• ";
  let content = outsideCode(serializePlainChildren(item, "list-item"), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
  if (!item.querySelector(":scope > p")) {
    content = outsideCode(content, (prose) => prose.replace(/\n{2,}/g, "\n"));
  }
  const continuationIndent = " ".repeat(bullet.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${bullet}${task}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

function serializePlainList(list: Element, ordered: boolean): string {
  const items = numberedListItems(list);
  if (items.length === 0) return "";
  return `${items.map(({ item, number }) => serializePlainListItem(item, ordered, number)).join("\n")}\n\n`;
}

function serializePlainTable(table: Element): string {
  const rows = [
    ...table.querySelectorAll(
      ":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr",
    ),
  ];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(
      cells
        .map((cell) => serializePlainChildren(cell, "inline").replace(/\n+/g, " ").trim())
        .join("\t"),
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
}

function serializePlainDetails(summary: string, content: string): string {
  return `${summary}${content ? `\n\n${content}` : ""}\n\n`;
}

function serializePlainBlockquote(element: Element): string {
  const body = outsideCode(serializePlainChildren(element, "block"), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
  const alertKind = element.getAttribute("data-alert");
  const alertTitle =
    alertKind && !element.querySelector(":scope > [data-markdown-alert-label]")
      ? (ALERT_TITLES[alertKind] ?? alertKind)
      : "";
  const combined = alertTitle && body ? `${alertTitle}\n\n${body}` : alertTitle || body;
  return combined ? `${combined}\n\n` : "";
}

function serializePlainPre(pre: Element): string {
  const code = (pre.textContent ?? "").replace(/\n$/, "");
  const codeChild = pre.querySelector(":scope > code");
  if (codeChild?.classList.contains("language-mermaid")) {
    return verbatimBlock(serializeCodeBlockToMarkdown(code, "mermaid").trimEnd());
  }
  return verbatimBlock(code);
}

function serializePlainTextNode(
  node: Text,
  containerKind: ContainerKind,
  afterBreak: boolean,
): string {
  let text = node.textContent ?? "";
  // wordsHast's breakLines emits `<br>` followed by `\n` on the next text node.
  if (afterBreak && text.startsWith("\n")) {
    text = text.slice(1);
  }
  const nextIsBlock = isBlockDomNode(node.nextSibling);
  if (text.trim().length === 0) {
    if (containerKind === "list-item" && nextIsBlock && text.includes("\n")) return "\n";
    if (containerKind === "block") {
      return !node.previousSibling ||
        !node.nextSibling ||
        isBlockDomNode(node.previousSibling) ||
        nextIsBlock
        ? ""
        : " ";
    }
    return text.includes("\n") && !text.includes(" ") ? " " : text;
  }
  if (containerKind === "list-item" && nextIsBlock && text.endsWith("\n")) {
    return `${text.slice(0, -1).replace(/\r?\n/g, " ")}\n`;
  }
  return text.replace(/\r?\n/g, " ");
}

function serializePlainChildren(node: Node, containerKind: ContainerKind): string {
  let out = "";
  let afterBreak = false;
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += serializePlainTextNode(child as Text, containerKind, afterBreak);
      afterBreak = false;
      continue;
    }
    afterBreak = child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === "BR";
    out += serializePlainNode(child);
  }
  return out;
}

function serializePlainNode(node: Node): string {
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;

  if (element.hasAttribute("data-markdown-details")) {
    const summary =
      element.querySelector(":scope > [data-markdown-details-summary]")?.textContent?.trim() ??
      "Details";
    const contentNode = element.querySelector(":scope > * [data-markdown-details-content]");
    const content = contentNode ? serializePlainChildren(contentNode, "block").trim() : "";
    return serializePlainDetails(summary, content);
  }

  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) {
    if (element.hasAttribute("data-markdown-mermaid")) {
      return verbatimBlock(markdownCopy.trimEnd());
    }
    if (element.hasAttribute("data-markdown-math") || isComposerContextMarkdownCopy(markdownCopy)) {
      return markdownCopy;
    }
    if (element.tagName === "IMG") {
      return element.getAttribute("alt") ?? "";
    }
    return serializePlainChildren(element, "inline");
  }

  if (isSkippedElement(element)) return "";

  if (element.hasAttribute("data-markdown-alert")) {
    return serializePlainBlockquote(element);
  }

  if (/^H[1-6]$/.test(element.tagName)) {
    const heading = serializePlainChildren(element, "inline").trim();
    return heading ? `${heading}\n\n` : "";
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "";
    case "P": {
      const paragraph = serializePlainChildren(element, "inline").trim();
      return paragraph ? `${paragraph}\n\n` : "";
    }
    case "PRE":
      return serializePlainPre(element);
    case "CODE":
      return element.textContent ?? "";
    case "IMG":
      return element.getAttribute("alt") ?? "";
    case "UL":
      return serializePlainList(element, false);
    case "OL":
      return serializePlainList(element, true);
    case "BLOCKQUOTE":
      return serializePlainBlockquote(element);
    case "TABLE":
      return serializePlainTable(element);
    case "DETAILS": {
      const summaryEl = element.querySelector(":scope > summary");
      const summary = summaryEl ? serializePlainChildren(summaryEl, "inline").trim() : "Details";
      let body = "";
      for (const child of element.childNodes) {
        if (child === summaryEl) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          body += serializePlainTextNode(child as Text, "block", false);
        } else {
          body += serializePlainNode(child);
        }
      }
      return serializePlainDetails(summary, body.trim());
    }
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializePlainChildren(element, "block");
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializePlainChildren(element, "inline");
  }
}

interface SoleCodeBlockScan {
  pre: Element | null;
  other: boolean;
}

function scanForSoleCodeBlock(node: Node, scan: SoleCodeBlockScan): void {
  for (const child of node.childNodes) {
    if (scan.other) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) scan.other = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (element.hasAttribute("data-markdown-details")) {
      scan.other = true;
      continue;
    }
    const markdownCopy = element.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) {
      if (markdownCopy.trim().length > 0) scan.other = true;
      continue;
    }
    if (isSkippedElement(element)) continue;
    if (element.tagName === "PRE") {
      if (scan.pre) scan.other = true;
      else scan.pre = element;
      continue;
    }
    if (element.tagName === "IMG" || element.tagName === "HR") {
      scan.other = true;
      continue;
    }
    if (element.tagName === "LI") {
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

/** Serializes a rendered Markdown DOM fragment to visible plain text without Markdown syntax. */
export function serializeRenderedPlainTextFragment(container: Node): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) {
    const code = (codeBlock.textContent ?? "").replace(/\n$/, "");
    const codeChild = codeBlock.querySelector(":scope > code");
    return codeChild?.classList.contains("language-mermaid")
      ? serializeCodeBlockToMarkdown(code, "mermaid").trimEnd()
      : code;
  }
  return tidyPlainText(serializePlainChildren(container, "block"));
}

export const PLAIN_TEXT_CLIPBOARD_OPTIONS = {
  serializeFragment: serializeRenderedPlainTextFragment,
  includeHtml: false,
} as const;

/** Converts an assistant Markdown message into the visible plain text shown to the user. */
export function markdownToPlainText(
  markdown: string,
  options: { readonly math?: boolean } = {},
): string {
  const source = renderCodexDirectivesForCopy(markdown);
  const tree = wordsHast(source, {
    math: options.math === true,
    breaks: shouldPreserveAssistantLineBreaks(source),
    escapeHtml: false,
    insights: source.includes("★ Insight"),
    extensions: EMPTY_EXTENSIONS,
  });
  const doc = new DOMParser().parseFromString(toHtml(tree), "text/html");
  return serializeRenderedPlainTextFragment(doc.body);
}
