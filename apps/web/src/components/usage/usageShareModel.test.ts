import type { SpeedRanking } from "@t3tools/shared/usageSpeed";
import { describe, expect, it } from "vite-plus/test";

import {
  buildShareData,
  defaultShareLang,
  modelDisplayName,
  shareAxis,
  shareFilename,
} from "./usageShareModel";

const ranking = (overrides: Partial<SpeedRanking>): SpeedRanking => ({
  provider: "claude",
  model: "claude-opus-5-5",
  tier: undefined,
  requests: 100,
  longRequests: 40,
  shortRequests: 10,
  outputTokens: 1_000_000,
  firstMs: 0,
  lastMs: 1,
  longRate: 92.7,
  allRate: 70,
  shortSeconds: 3.8,
  lowSample: false,
  dispatch: null,
  ...overrides,
});

describe("modelDisplayName", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-fable-5-2", "Claude Fable 5.2"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-oss-120b-medium", "GPT-OSS 120B (medium)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (high)"],
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (high)"],
    ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (high)"],
    ["deepseek-flash", "DeepSeek V4.1 Flash"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["grok-4.6-build", "Grok 4.6"],
    ["deepseek/deepseek-flash", "DeepSeek V4.1 Flash"],
  ])("turns %s into %s", (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });
});

describe("buildShareData", () => {
  it("leaves out rows without a long-output sample and keeps the rest in rank order", () => {
    const data = buildShareData(
      [
        ranking({ model: "claude-haiku-5-5", longRate: 200.3 }),
        ranking({
          provider: "opencode",
          model: "deepseek-flash",
          longRate: 175.7,
          lowSample: true,
        }),
        ranking({ provider: "codex", model: "gpt-6-luna", longRate: null, allRate: 80 }),
        ranking({ provider: "codex", model: "gpt-6.1-sol", tier: "fast", longRate: 61.5 }),
      ],
      { sinceDay: "2026-08-19", untilDay: "2026-11-17" },
      "zh",
    );
    expect(data.rows.map((row) => [row.rank, row.name, row.color, row.channel.label])).toEqual([
      [1, "Claude Haiku 5.5", "#d95926", "Claude Code"],
      [2, "DeepSeek V4.1 Flash", "#c060c0", "OpenCode"],
      [3, "GPT-6.1 Sol (fast)", "#199e70", "Codex"],
    ]);
    expect(data.rows[1]?.channel.color).toBe("#8a93a3");
    expect(data.rows[1]?.thin).toBe(true);
    expect(data.vendors.map((vendor) => vendor.name)).toEqual(["Anthropic", "OpenAI", "DeepSeek"]);
    expect(data.strings.subtitle).toContain("2026-08-19 至 2026-11-17");
    expect(data.strings.brand).toBe("由 T3 Code 生成");
    expect(data.axis.ticks).toEqual([0, 50, 100, 150, 200]);
  });

  it("shows the dispatch column only when a record exists, and signs per language", () => {
    const period = { sinceDay: "2026-08-19", untilDay: "2026-11-17" };
    const none = buildShareData([ranking({})], period, "en");
    expect(none.showDispatch).toBe(false);
    expect(none.strings.noDispatchKey).toBeNull();
    expect(none.strings.brand).toBe("Generated with T3 Code");
    const some = buildShareData(
      [ranking({ dispatch: { successes: 32, total: 35 } }), ranking({ model: "claude-fable-5-1" })],
      period,
      "en",
    );
    expect(some.rows.map((row) => row.dispatch)).toEqual(["32/35", null]);
    expect(some.strings.noDispatchKey).toBe("—: no delegated tasks");
  });
});

describe("share helpers", () => {
  it("picks the interface language and builds the file name", () => {
    expect(defaultShareLang("zh-Hans")).toBe("zh");
    expect(defaultShareLang("en")).toBe("en");
    expect(defaultShareLang("ja")).toBe("en");
    expect(shareFilename("2026-11-17", "zh")).toBe("model-speed-2026-11-17-zh.png");
  });

  it("scales the axis to the fastest row", () => {
    expect(shareAxis(200.3).ticks).toEqual([0, 50, 100, 150, 200]);
    expect(shareAxis(95).ticks).toEqual([0, 20, 40, 60, 80]);
    expect(shareAxis(1200).ticks.at(-1)).toBeLessThanOrEqual(1260);
  });
});
