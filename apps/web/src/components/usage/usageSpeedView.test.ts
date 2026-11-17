import type { SpeedRanking } from "@t3tools/shared/usageSpeed";
import { describe, expect, it } from "vite-plus/test";

import { formatRate, speedBarShares, speedBarValue, speedModelLabel } from "./usageSpeedView";

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
    expect(speedModelLabel(ranking({ tier: "fast" }))).toBe("claude-opus-5-5 (fast)");
  });
});
