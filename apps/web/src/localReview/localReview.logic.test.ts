import type { LocalReviewCommit } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { commitBody, relativeLabel } from "./localReview.logic";

it("shows the message after the subject paragraph", () => {
  const message = (text: string) => ({ message: text }) as LocalReviewCommit;
  expect(commitBody(message("标题"))).toBe("");
  expect(commitBody(message("标题\n\n第一段\n\n第二段"))).toBe("第一段\n\n第二段");
});

it("words relative times in Chinese", () => {
  expect(relativeLabel({ status: "relative", value: "just now", suffix: null })).toBe("刚刚");
  expect(relativeLabel({ status: "relative", value: "5m", suffix: "ago" })).toBe("5 分钟前");
  expect(relativeLabel({ status: "relative", value: "3h", suffix: "ago" })).toBe("3 小时前");
  expect(relativeLabel({ status: "relative", value: "2d", suffix: "ago" })).toBe("2 天前");
  expect(relativeLabel({ status: "missing" })).toBe("");
});
