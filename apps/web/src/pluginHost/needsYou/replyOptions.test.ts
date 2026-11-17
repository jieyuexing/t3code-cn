import { describe, expect, it } from "vite-plus/test";
import { replyOptions } from "./replyOptions";

const labels = (reply: string) => {
  const options = replyOptions(reply);
  return options === "multi" ? options : options.map((option) => option.label);
};

describe("提取带标号的选项", () => {
  it("正样本一：粗体标号，说明接在后面", () => {
    const reply = [
      "两条路：",
      "",
      "**甲（推荐）：只改现有的派发检查**",
      "**乙：再在实际执行处拦一道**",
      "**丙：不改检查**",
    ].join("\n");
    expect(replyOptions(reply)).toEqual([
      { label: "甲", recommended: true, text: "（推荐）只改现有的派发检查" },
      { label: "乙", recommended: false, text: "再在实际执行处拦一道" },
      { label: "丙", recommended: false, text: "不改检查" },
    ]);
  });

  it("正样本二：序号加标号，可带“选项”“方案”前缀与全角分隔", () => {
    expect(labels("1. 方案A：保留\n2. 方案B：删除")).toEqual(["A", "B"]);
    expect(labels("- 选项 甲、保留\n- 选项 乙、删除")).toEqual(["甲", "乙"]);
    expect(labels("1. 甲（先做）\n2. 乙（后做）")).toEqual(["甲", "乙"]);
  });

  it("反样本一：标号后紧跟别的字，不是选项", () => {
    expect(replyOptions("1. 甲方已确认\n2. 乙方待定\n3. Apple 已发布")).toEqual([]);
  });

  it("反样本二：没有列表符也不是粗体的行，只有一项也不算", () => {
    expect(replyOptions("甲：保留\n乙：删除")).toEqual([]);
    expect(replyOptions("**甲**：只有这一项")).toEqual([]);
    expect(replyOptions("")).toEqual([]);
  });

  it("同一标号出现两次以上是多组，标号不再可信", () => {
    expect(labels("**甲**：先说 X\n**乙**：再说 X\n\n另一件事：\n**甲**：保留\n**乙**：删除")).toBe(
      "multi",
    );
  });

  it("只有一个标号重复时没有选项", () => {
    expect(replyOptions("**甲**：a\n**甲**：b")).toEqual([]);
  });

  it("推荐项排第一，其余保持原顺序；“不推荐”不算推荐", () => {
    const options = replyOptions("- **甲**：不推荐\n- **乙**：慢\n- **丙（推荐）**：快");
    expect(options).toMatchObject([
      { label: "丙", recommended: true },
      { label: "甲", recommended: false },
      { label: "乙", recommended: false },
    ]);
  });

  it("英文 recommended 同样算推荐项，not recommended 不算，括号后的冒号不留", () => {
    const options = replyOptions(
      "- **A**: Not recommended, slow\n- **B (Recommended)**: Read it from config",
    );
    expect(options).toEqual([
      { label: "B", recommended: true, text: "(Recommended) Read it from config" },
      { label: "A", recommended: false, text: "Not recommended, slow" },
    ]);
  });

  it("最多四项，推荐项在第五位时仍排进来", () => {
    expect(labels("- 甲. 一\n- 乙. 二\n- 丙. 三\n- 丁. 四\n- A. 五（推荐）")).toEqual([
      "A",
      "甲",
      "乙",
      "丙",
    ]);
  });

  it("标题写成“3. 待你定：…”时，标题不算选项，标号照常取", () => {
    const reply = "做完了。\n\n3. 待你定：\n   - 甲：合并\n   - 乙：不合并\n";
    expect(labels(reply)).toEqual(["甲", "乙"]);
  });

  it("去掉说明里的 Markdown 标记", () => {
    expect(
      replyOptions("- **乙**：改 `main` 与 [说明](http://x.test)\n- **丙**：不改"),
    ).toMatchObject([{ label: "乙", text: "改 main 与 说明" }, { label: "丙" }]);
  });
});
