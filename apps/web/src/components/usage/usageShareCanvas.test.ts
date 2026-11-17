import { describe, expect, it } from "vite-plus/test";

import { wrapText } from "./usageShareCanvas";

// One unit per character, so widths are easy to read.
const measure = (value: string) => value.length;

describe("wrapText", () => {
  it("breaks Latin text between words and drops trailing spaces", () => {
    expect(wrapText(measure, "speed is output tokens over time", 16)).toEqual([
      "speed is output",
      "tokens over time",
    ]);
  });

  it("breaks CJK text at any character and keeps Latin words whole", () => {
    expect(wrapText(measure, "速率等于输出 token 除以耗时", 8)).toEqual([
      "速率等于输出",
      "token 除以",
      "耗时",
    ]);
  });

  it("keeps the spaces between CJK text and Latin words", () => {
    expect(wrapText(measure, "速率 = 输出 token 之比", 40)).toEqual(["速率 = 输出 token 之比"]);
  });

  it("keeps a single over-long word on its own line", () => {
    expect(wrapText(measure, "a supercalifragilistic b", 5)).toEqual([
      "a",
      "supercalifragilistic",
      "b",
    ]);
  });
});
