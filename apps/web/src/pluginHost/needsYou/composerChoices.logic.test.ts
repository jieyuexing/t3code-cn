import { describe, expect, it } from "vite-plus/test";
import { composerChoices, mergeComposerChoices, mergedAdvisorFill } from "./composerChoices.logic";
import type { PromptAdvisorItem } from "./promptAdvisorPayload.cn";

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
});

const advisor = (
  kind: PromptAdvisorItem["kind"],
  label: string,
  fill: string,
): PromptAdvisorItem => ({
  kind,
  label,
  fill,
});
const LISTED = "**甲（推荐）**：快\n**乙**：稳";
const view = (reply: string, items: ReadonlyArray<PromptAdvisorItem>) =>
  mergeComposerChoices(reply, items).map((choice) => [
    choice.source ?? "rule",
    choice.badge,
    choice.fill,
  ]);

describe("规则按钮与上下文顾问的融合", () => {
  it("没有顾问建议时与规则按钮完全一致", () => {
    expect(mergeComposerChoices(LISTED, [])).toEqual(composerChoices(LISTED));
    expect(mergeComposerChoices("做完了。", [])).toEqual([]);
  });

  it("规则有按钮：全部保留原顺序，只追加 1 枚顾问按钮，优先 challenge，其次 angle，忽略 next", () => {
    const items = [
      advisor("next", "验收", "先跑回归"),
      advisor("angle", "第三条路", "有没有不拆分的做法？"),
      advisor("challenge", "漏了回滚", "两个方案都没说怎么回滚？"),
    ];
    expect(view(LISTED, items)).toEqual([
      ["rule", undefined, "甲"],
      ["rule", undefined, "乙"],
      ["rule", undefined, "按推荐"],
      ["advisor", "盲点", "两个方案都没说怎么回滚？"],
    ]);
    expect(view(LISTED, items.slice(0, 2)).at(-1)).toEqual([
      "advisor",
      "换角度",
      "有没有不拆分的做法？",
    ]);
    expect(view(LISTED, [advisor("next", "验收", "先跑回归")])).toHaveLength(3);
  });

  it("只有「按推荐」时同样追加 1 枚", () => {
    expect(view("## 待你定\n1. 合并吗？", [advisor("challenge", "盲点", "CI 绿了吗？")])).toEqual([
      ["rule", undefined, "按推荐"],
      ["advisor", "盲点", "CI 绿了吗？"],
    ]);
  });

  it("规则为空：顾问的 1–3 枚全部展示，徽标按 kind，英文 fill 用英文徽标；2 枚以上末尾追加合并按钮", () => {
    expect(
      view("改完了，测试通过。", [
        advisor("challenge", "盲点", "回归测试覆盖了吗？"),
        advisor("next", "验收", "跑一遍完整测试"),
        advisor("angle", "收窄", "只改登录页会怎样？"),
      ]),
    ).toEqual([
      ["advisor", "反问", "回归测试覆盖了吗？"],
      ["advisor", "推进", "跑一遍完整测试"],
      ["advisor", "换角度", "只改登录页会怎样？"],
      [
        "advisor",
        "全部",
        "请逐条回应以下几点：\n1. 回归测试覆盖了吗？\n2. 跑一遍完整测试\n3. 只改登录页会怎样？",
      ],
    ]);
    expect(
      view("Done.", [
        advisor("challenge", "Gap", "Did the regression suite cover this?"),
        advisor("next", "Verify", "Run the full suite"),
        advisor("angle", "Narrow", "What if only the login page changes?"),
      ]).map(([, badge]) => badge),
    ).toEqual(["Challenge", "Next", "Angle", "全部"]);
    expect(view(LISTED, [advisor("challenge", "Gap", "Did you check rollback?")]).at(-1)?.[1]).toBe(
      "Blind spot",
    );
  });

  it("合并按钮：0 或 1 枚顾问不出，有解析选项时不出，2 或 3 枚单独顾问时追加且文本正确", () => {
    expect(mergedAdvisorFill([])).toBe("");
    expect(mergeComposerChoices("改完了。", [])).toEqual([]);
    expect(mergeComposerChoices("改完了。", [advisor("next", "验收", "跑测试")])).toHaveLength(1);

    const two = mergeComposerChoices("改完了。", [
      advisor("challenge", "盲点", "回归覆盖了吗？"),
      advisor("next", "验收", "跑一遍完整测试"),
    ]);
    expect(two).toHaveLength(3);
    expect(two.at(-1)).toEqual({
      source: "advisor",
      badge: "全部",
      label: "合并 2 条",
      fill: "请逐条回应以下几点：\n1. 回归覆盖了吗？\n2. 跑一遍完整测试",
      detail: "",
    });

    const three = mergeComposerChoices("改完了。", [
      advisor("challenge", "盲点", "问题一"),
      advisor("next", "验收", "问题二"),
      advisor("angle", "收窄", "问题三"),
    ]);
    expect(three).toHaveLength(4);
    expect(three.at(-1)).toEqual({
      source: "advisor",
      badge: "全部",
      label: "合并 3 条",
      fill: "请逐条回应以下几点：\n1. 问题一\n2. 问题二\n3. 问题三",
      detail: "",
    });

    const withOptions = mergeComposerChoices(LISTED, [
      advisor("challenge", "盲点", "漏了回滚？"),
      advisor("angle", "收窄", "能不能先灰度？"),
    ]);
    expect(withOptions.some((choice) => choice.badge === "全部")).toBe(false);

    const withPendingOnly = mergeComposerChoices("## 待你定\n1. 要不要合并？", [
      advisor("challenge", "盲点", "CI 绿了吗？"),
      advisor("angle", "收窄", "能不能拆成两步？"),
    ]);
    expect(withPendingOnly.some((choice) => choice.badge === "全部")).toBe(false);
  });

  it("顾问按钮保留 kind、label 与完整 fill", () => {
    expect(mergeComposerChoices("Done.", [advisor("next", "Verify", "Run it")])).toEqual([
      {
        source: "advisor",
        kind: "next",
        badge: "Next",
        label: "Verify",
        fill: "Run it",
        detail: "",
      },
    ]);
  });
});
