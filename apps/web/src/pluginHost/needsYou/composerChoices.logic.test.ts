import { describe, expect, it } from "vite-plus/test";
import { composerChoices } from "./composerChoices.logic";

const fills = (reply: string) => composerChoices(reply).map((choice) => choice.fill);

describe("输入框决策快捷条的按钮", () => {
  it("两个以上选项：选项加「按推荐」，推荐项在前", () => {
    expect(fills("**甲**：慢\n**乙（推荐）**：快\n**丙**：折中")).toEqual([
      "乙",
      "甲",
      "丙",
      "按推荐",
    ]);
  });

  it("只有一个标号或没有选项：没有按钮", () => {
    expect(fills("**甲**：只有一项")).toEqual([]);
    expect(fills("做完了。")).toEqual([]);
  });

  it("多组选项，或只有「待你定」没有标号：只给「按推荐」", () => {
    expect(fills("**甲**：a\n**乙**：b\n\n**甲**：c\n**乙**：d")).toEqual(["按推荐"]);
    expect(fills("## 待你定\n1. 要不要合并？")).toEqual(["按推荐"]);
  });

  it("回复没有中日韩文字时，按钮和发出的话都是英文", () => {
    const reply = "**A (recommended)**: Lax\n**B**: Same-site";
    expect(fills(reply)).toEqual(["A", "B", "Go with your recommendation"]);
    expect(fills("**A**: slow\n**B (recommended)**: fast")).toEqual([
      "B",
      "A",
      "Go with your recommendation",
    ]);
    expect(fills("**甲**：慢\n**乙**：快 with CI")).toEqual(["甲", "乙", "按推荐"]);
  });
});
