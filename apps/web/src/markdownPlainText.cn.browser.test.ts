import { describe, expect, it } from "vite-plus/test";

import {
  isComposerContextMarkdownCopy,
  markdownToPlainText,
  serializeRenderedPlainTextFragment,
} from "./markdownPlainText.cn";

describe("markdownToPlainText", () => {
  it("strips Markdown formatting while preserving readable structure", () => {
    const markdown = [
      "# Heading One",
      "",
      "Paragraph with **bold**, *italic*, ~~strike~~, `inline()`, [docs](https://example.com/docs), and ![diagram](https://example.com/a.png).",
      "",
      "- First bullet",
      "- Second bullet",
      "  - Nested bullet",
      "",
      "10. Tenth step",
      "11. Eleventh step",
      "",
      "- [ ] Todo",
      "- [x] Done",
      "",
      "> Quoted text",
      "",
      "> [!WARNING]",
      "> Check backup",
      "",
      "| Name | Value |",
      "| :--- | ---: |",
      "| Alpha | 42 |",
      "",
      "```ts",
      "const x = 1;",
      "  return x;",
      "```",
    ].join("\n");

    expect(markdownToPlainText(markdown)).toBe(
      [
        "Heading One",
        "",
        "Paragraph with bold, italic, strike, inline(), docs, and diagram.",
        "",
        "• First bullet",
        "• Second bullet",
        "  • Nested bullet",
        "",
        "10. Tenth step",
        "11. Eleventh step",
        "",
        "• ☐ Todo",
        "• ☑ Done",
        "",
        "Quoted text",
        "",
        "Warning",
        "",
        "Check backup",
        "",
        "Name\tValue",
        "Alpha\t42",
        "",
        "const x = 1;",
        "  return x;",
      ].join("\n"),
    );
  });

  it("preserves mermaid and math source and resolves Codex directives", () => {
    const markdown = [
      'See $x^2$ and :codex-file-citation[app.ts]{path="src/app.ts"}.',
      "",
      "```mermaid",
      "graph TD;",
      "  A-->B;",
      "```",
      "",
      '::artifact-template{artifact_kind="document" display_name="Spec" skill_directory="/s" skill_name="artifact-template-spec"}',
    ].join("\n");

    expect(markdownToPlainText(markdown, { math: true })).toBe(
      [
        "See \\(x^2\\) and app.ts.",
        "",
        "```mermaid",
        "graph TD;",
        "  A-->B;",
        "```",
        "",
        "Spec (Document template)",
      ].join("\n"),
    );
  });

  it("keeps soft newlines inside preserved-line-break lists without doubling", () => {
    const markdown = ["1. First item", "2. Second item", "", "Line A", "Line B"].join("\n");
    expect(markdownToPlainText(markdown)).toBe("1. First item\n2. Second item\n\nLine A Line B");
  });

  it("detects composer context markdown copy markers and keeps them in DOM serialization", () => {
    expect(isComposerContextMarkdownCopy("[App.tsx](t3-context://v1/mention/m1)")).toBe(true);
    expect(isComposerContextMarkdownCopy("[App.tsx](/tmp/App.tsx)")).toBe(false);

    const container = document.createElement("div");
    container.innerHTML =
      '<p>See <button type="button" data-markdown-copy="[App.tsx](t3-context://v1/mention/m1)">App.tsx</button> and <strong>bold</strong></p>';
    expect(serializeRenderedPlainTextFragment(container)).toBe(
      "See [App.tsx](t3-context://v1/mention/m1) and bold",
    );
  });
});
