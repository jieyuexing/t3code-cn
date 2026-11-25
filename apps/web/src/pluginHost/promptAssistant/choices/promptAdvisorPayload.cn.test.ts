import { describe, expect, it } from "vite-plus/test";

import {
  PROMPT_ADVISOR_PREFIX,
  isPromptAdvisorPayload,
  parsePromptAdvisorPayload,
} from "./promptAdvisorPayload.cn";

const encode = (value: unknown) => `${PROMPT_ADVISOR_PREFIX}${JSON.stringify(value)}`;
const item = (kind: string, label: string, fill: string) => ({ kind, label, fill });

describe("上下文顾问的编码串", () => {
  it("前缀与服务端约定一致", () => {
    expect(PROMPT_ADVISOR_PREFIX).toBe("\u001et3cn-advisor:v1:");
  });

  it("解出 1–3 条建议", () => {
    expect(
      parsePromptAdvisorPayload(
        encode({
          items: [item("challenge", "盲点", "回归测试覆盖了吗？"), item("next", "验收", "跑一遍")],
        }),
      ),
    ).toEqual([item("challenge", "盲点", "回归测试覆盖了吗？"), item("next", "验收", "跑一遍")]);
  });

  it("丢弃坏条目，最多留 3 条", () => {
    const parsed = parsePromptAdvisorPayload(
      encode({
        items: [
          item("praise", "夸", "好"),
          item("next", "", "空 label"),
          item("next", "空 fill", " "),
          null,
          item("next", "a", "a"),
          item("next", "b", "b"),
          item("angle", "c", "c"),
          item("angle", "d", "d"),
        ],
      }),
    );
    expect(parsed?.map((entry) => entry.label)).toEqual(["a", "b", "c"]);
  });

  it("带前缀但坏掉的串仍算协议串，解出空列表，不会当成灰字", () => {
    for (const damaged of [
      `${PROMPT_ADVISOR_PREFIX}{not json`,
      `${PROMPT_ADVISOR_PREFIX}`,
      encode({ items: "nope" }),
      encode(null),
      encode({ items: [] }),
    ]) {
      expect(isPromptAdvisorPayload(damaged)).toBe(true);
      expect(parsePromptAdvisorPayload(damaged)).toEqual([]);
    }
  });

  it("普通字符串和 null 不是协议串", () => {
    expect(isPromptAdvisorPayload("跑一下测试")).toBe(false);
    expect(isPromptAdvisorPayload(null)).toBe(false);
    expect(parsePromptAdvisorPayload("跑一下测试")).toBeNull();
    expect(parsePromptAdvisorPayload(null)).toBeNull();
  });
});
