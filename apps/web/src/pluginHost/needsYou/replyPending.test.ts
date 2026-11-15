import { describe, expect, it } from "vite-plus/test";
import { pendingItems } from "./replyPending";

describe("找「待你定」段", () => {
  it.each([
    ["## 待你定"],
    ["### 待你定"],
    ["**待你定**"],
    ["**待你定：**"],
    ["待你定"],
    ["待你定："],
  ])("标题写成 %s", (heading) => {
    expect(pendingItems(`做完了。\n\n${heading}\n1. 要不要合并？\n`)).toEqual(["要不要合并？"]);
  });

  it.each([
    ["**待你定**：要不要合并？"],
    ["**待你定：**要不要合并？"],
    ["**待你定：** 要不要合并？"],
    ["待你定: 要不要合并？"],
    ["## 待你定：要不要合并？"],
  ])("标题和正文写在同一行：%s", (line) => {
    expect(pendingItems(`做完了。\n\n${line}\n`)).toEqual(["要不要合并？"]);
  });

  it("标题后同一行有正文时，这一行就是一项，其后的说明行和选项列表不再读", () => {
    expect(pendingItems("**待你定**：要不要合并？\n合并会丢当天数据。\n第三行不要。")).toEqual([
      "要不要合并？",
    ]);
    expect(pendingItems("**待你定**：要不要合并？\n- 方案甲\n- 方案乙")).toEqual(["要不要合并？"]);
  });

  it.each([["剩下的要你来定："], ["这几项要你定，我先不动："], ["以下等你定:"]])(
    "以冒号收尾、引出列表的一句话也算标题：%s",
    (lead) => {
      expect(
        pendingItems(
          `做完了。\n\n${lead}\n\n1. **要不要合并**：理由。\n   - A：合并\n2. 周五前给回复\n\n收尾说明。`,
        ),
      ).toEqual(["要不要合并：理由。", "周五前给回复"]);
    },
  );

  it("引出句是列表项或没有冒号时不算标题", () => {
    expect(pendingItems("- 这项不用你来定：\n1. 照做")).toEqual([]);
    expect(pendingItems("这项不用你来定。\n1. 照做")).toEqual([]);
  });

  it("正文里提到待你定但不是单独一行，不算标题", () => {
    expect(pendingItems("这轮没有待你定的事。\n待你定的事见下文。")).toEqual([]);
  });

  it("没有这一段，或这一段是空的，不列", () => {
    expect(pendingItems("## 结果\n都做完了。")).toEqual([]);
    expect(pendingItems("## 待你定\n\n## 下一步\n- 继续")).toEqual([]);
    expect(pendingItems("")).toEqual([]);
  });
});

describe("段内条目", () => {
  it("编号与无序列表都算，取每项第一行并去掉 Markdown 标记", () => {
    expect(
      pendingItems(
        [
          "## 待你定",
          "1. **是否** 合并 `main`？",
          "   理由写在这里，不算问题。",
          "2) 看 [方案](http://x.test/a) 再定",
          "- [ ] 周五前给回复",
          "",
          "## 下一步",
          "- 不属于这一段",
        ].join("\n"),
      ),
    ).toEqual(["是否 合并 main？", "看 方案 再定", "周五前给回复"]);
  });

  it("只取最外层条目，嵌套的子项不单列", () => {
    expect(pendingItems("### 待你定\n- 选哪个库？\n  - A\n  - B\n- 要不要上线？")).toEqual([
      "选哪个库？",
      "要不要上线？",
    ]);
  });

  it("没有列表时整段前两行算一项", () => {
    expect(
      pendingItems("## 待你定\n\n是否先停掉旧任务？\n停掉会丢当天数据。\n第三行不要。"),
    ).toEqual(["是否先停掉旧任务？ 停掉会丢当天数据。"]);
  });

  it("粗体标题的段在下一个粗体标题处结束，井号标题的段只被同级或更高的标题结束", () => {
    expect(pendingItems("**待你定**\n- 甲\n**备注**\n- 乙")).toEqual(["甲"]);
    expect(pendingItems("## 待你定\n- 甲\n### 细节\n- 乙\n## 其他\n- 丙")).toEqual(["甲", "乙"]);
  });

  it("有多个标题时取最后一个", () => {
    expect(pendingItems("## 待你定\n- 旧的\n\n## 待你定\n- 新的")).toEqual(["新的"]);
  });

  it("正文被截断在条目中间，已读到的部分照常算；截断在标题之前则没有这一段", () => {
    expect(pendingItems("……\n## 待你定\n1. 要不要把旧表迁到新库，还是")).toEqual([
      "要不要把旧表迁到新库，还是",
    ]);
    expect(pendingItems("很长的正文……被截")).toEqual([]);
  });
});
