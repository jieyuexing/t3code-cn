import type { SpeedRanking } from "@t3tools/shared/usageSpeed";
import { describe, expect, it } from "vite-plus/test";

import {
  foldSpeedRows,
  foldToggleLabel,
  formatRate,
  speedBarShares,
  speedBarValue,
  speedModelLabel,
} from "./usageSpeedView";

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

describe("usage speed view", () => {
  it("falls back to the all-request speed, marked thin, when no long request exists", () => {
    expect(speedBarValue(ranking({ longRate: null, allRate: 55 }))).toEqual({
      value: 55,
      thin: true,
    });
    expect(speedBarValue(ranking({ lowSample: true }))).toEqual({ value: 92.7, thin: true });
  });

  it("scales bars to the fastest row", () => {
    expect(
      speedBarShares([
        ranking({ longRate: 200 }),
        ranking({ longRate: 50 }),
        ranking({ longRate: null, allRate: 0 }),
      ]),
    ).toEqual([1, 0.25, 0]);
  });

  it("formats rates and tier labels", () => {
    expect(formatRate(92.74)).toBe("92.7");
    expect(formatRate(124.6)).toBe("125");
    expect(speedModelLabel(ranking({ tier: "fast" }))).toBe("Claude Opus 5.5 (fast)");
  });

  it("folds rows with few long samples behind a toggle and lists them after the rest", () => {
    const rows = [
      ranking({ model: "claude-opus-5-5", longRate: 90 }),
      ranking({ model: "gemini-pro-orchestrator-neon", longRate: 300, lowSample: true }),
      ranking({ model: "claude-sonnet-5-5", longRate: 60 }),
      ranking({ model: "gpt-5.6-terra", longRate: null, lowSample: true }),
    ];
    const names = (listed: readonly SpeedRanking[]) => listed.map((row) => row.model);
    const collapsed = foldSpeedRows(rows, false);
    expect(names(collapsed.rows)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(collapsed.folded).toBe(2);
    const expanded = foldSpeedRows(rows, true);
    expect(names(expanded.rows)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gemini-pro-orchestrator-neon",
      "gpt-5.6-terra",
    ]);
    expect(expanded.folded).toBe(2);
  });

  it("folds nothing when no row has enough samples", () => {
    const rows = [ranking({ lowSample: true }), ranking({ model: "x", lowSample: true })];
    expect(foldSpeedRows(rows, false)).toEqual({ rows, folded: 0 });
  });

  it("words the toggle in both languages", () => {
    expect(foldToggleLabel(4, false, "zh")).toBe("另有 4 个样本少的行");
    expect(foldToggleLabel(4, true, "zh")).toBe("收起样本少的行");
    expect(foldToggleLabel(1, false, "en")).toBe("1 more row with few samples");
    expect(foldToggleLabel(4, false, "en")).toBe("4 more rows with few samples");
  });
});
