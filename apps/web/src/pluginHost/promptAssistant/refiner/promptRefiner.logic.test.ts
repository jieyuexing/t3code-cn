import { describe, expect, it } from "vite-plus/test";

import { m } from "~/i18n/messages";

import {
  applyRefinedText,
  buildRefineRequest,
  canRefine,
  DEFAULT_REFINE_MODE,
  isRefineShortcut,
  PROMPT_REFINE_MODE_META,
  parseRefineResponse,
  planApply,
  planUndo,
  refineFailureMessage,
  refineUrl,
} from "./promptRefiner.logic";

describe("canRefine", () => {
  it("needs a non-blank draft and an enabled composer", () => {
    expect(canRefine("看一下架构", false)).toBe(true);
    expect(canRefine("  \n", false)).toBe(false);
    expect(canRefine("看一下架构", true)).toBe(false);
  });
});

describe("buildRefineRequest", () => {
  it("sends only the fields that carry information", () => {
    expect(
      buildRefineRequest({
        draft: "草稿",
        selection: { start: 1, end: 1 },
        mode: "bold",
        projectId: "p1",
        threadId: null,
      }),
    ).toEqual({ draft: "草稿", mode: "bold", projectId: "p1" });
    expect(
      buildRefineRequest({
        draft: "草稿稿",
        selection: { start: 1, end: 3 },
        mode: DEFAULT_REFINE_MODE,
        projectId: null,
        threadId: "t1",
      }),
    ).toEqual({
      draft: "草稿稿",
      selection: { start: 1, end: 3 },
      mode: "structured",
      threadId: "t1",
    });
  });

  it("drops a selection that does not fit the draft", () => {
    for (const selection of [
      { start: 2, end: 9 },
      { start: -1, end: 2 },
      { start: 3, end: 1 },
    ]) {
      expect(
        buildRefineRequest({
          draft: "草稿",
          selection,
          mode: "structured",
          projectId: null,
          threadId: null,
        }),
      ).not.toHaveProperty("selection");
    }
  });
});

describe("applyRefinedText", () => {
  it("replaces the selection only", () => {
    expect(applyRefinedText("前文看架构后文", { start: 2, end: 5 }, "替换")).toEqual({
      text: "前文替换后文",
      start: 2,
      end: 4,
    });
  });

  it("replaces the whole draft without a selection", () => {
    expect(applyRefinedText("旧草稿", undefined, "新稿")).toEqual({
      text: "新稿",
      start: 0,
      end: 2,
    });
    expect(applyRefinedText("旧草稿", { start: 2, end: 2 }, "新稿").text).toBe("新稿");
  });
});

describe("planApply and planUndo", () => {
  const snapshot = { draft: "前文看架构后文", selection: { start: 2, end: 5 } };

  it("replaces the captured selection when its text is still there", () => {
    expect(planApply(snapshot, "前文看架构后文", "替换")).toEqual({
      kind: "replace",
      start: 2,
      end: 5,
      expectedText: "看架构",
      replacement: "替换",
      original: "看架构",
    });
  });

  it("refuses a selection whose text changed meanwhile", () => {
    expect(planApply(snapshot, "前文改了后文", "替换")).toEqual({ kind: "selection-changed" });
  });

  it("replaces the current whole draft and flags it stale when it moved on", () => {
    const whole = { draft: "旧草稿", selection: undefined };
    expect(planApply(whole, "旧草稿", "新稿")).toEqual({
      kind: "replace",
      start: 0,
      end: 3,
      expectedText: "旧草稿",
      replacement: "新稿",
      original: "旧草稿",
    });
    expect(planApply(whole, "旧草稿加了字", "新稿")).toMatchObject({
      end: 6,
      original: "旧草稿加了字",
    });
  });

  it("undoes by putting the original back over the applied range", () => {
    const plan = planApply(snapshot, "前文看架构后文", "替换");
    if (plan.kind !== "replace") throw new Error("expected a replace plan");
    expect(planUndo(plan)).toEqual({
      start: 2,
      end: 4,
      expectedText: "替换",
      replacement: "看架构",
    });
  });
});

describe("parseRefineResponse", () => {
  it("accepts the route's shape only", () => {
    expect(
      parseRefineResponse({ refined: "好", mode: "bold", usedWorkspaceContext: true }),
    ).toEqual({ refined: "好", mode: "bold", usedWorkspaceContext: true });
    expect(
      parseRefineResponse({ refined: "", mode: "bold", usedWorkspaceContext: true }),
    ).toBeNull();
    expect(
      parseRefineResponse({ refined: "好", mode: "x", usedWorkspaceContext: true }),
    ).toBeNull();
    expect(parseRefineResponse(null)).toBeNull();
  });
});

describe("refineFailureMessage", () => {
  it("explains each status in plain English", () => {
    expect(refineFailureMessage(503)).toContain("advisor");
    expect(refineFailureMessage(502)).toContain("Try again");
    expect(refineFailureMessage(401)).toContain("expired");
    expect(refineFailureMessage(403)).toContain("permission");
    expect(refineFailureMessage(400)).toContain("Draft");
    expect(refineFailureMessage(500)).toContain("500");
  });
});

describe("refineUrl", () => {
  it("joins the base, path and ticket query", () => {
    expect(refineUrl({ httpBase: "https://h.test/api/cn", query: { wsTicket: "a b" } })).toBe(
      "https://h.test/api/cn/prompt-refine?wsTicket=a+b",
    );
    expect(refineUrl({ httpBase: "https://h.test/api/cn", query: {} })).toBe(
      "https://h.test/api/cn/prompt-refine",
    );
  });
});

describe("isRefineShortcut", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      key: "y",
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...init,
    }) as KeyboardEvent;

  it("uses Cmd+Shift+Y on macOS and Ctrl+Shift+Y elsewhere", () => {
    expect(isRefineShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isRefineShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isRefineShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isRefineShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isRefineShortcut(key({ metaKey: true, key: "Y" }), true)).toBe(true);
    expect(isRefineShortcut(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isRefineShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
  });
});

describe("PROMPT_REFINE_MODE_META", () => {
  it("names the three modes in the order the card shows them", () => {
    expect(PROMPT_REFINE_MODE_META.map((entry) => [entry.mode, m(entry.label)])).toEqual([
      ["structured", "Structured"],
      ["bold", "Divergent"],
      ["scoped", "Scoped"],
    ]);
  });
});
