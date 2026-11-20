import { describe, expect, it } from "@effect/vitest";

import { parseDispatchScores } from "./dispatchScores.ts";

const line = (overrides: object, executor = { provider: "claude", model: "claude-sonnet-5-5" }) =>
  JSON.stringify({
    accepted: true,
    falseReport: false,
    scopeViolation: false,
    stoppedOnDenial: null,
    reworkRounds: 0,
    executor: { ...executor, effort: "high", tier: "default", site: "m3max" },
    ...overrides,
  });

describe("parseDispatchScores", () => {
  it("counts a dispatch as a success only by the scoring formula", () => {
    const scores = parseDispatchScores(
      [
        line({}),
        line({ reworkRounds: 1 }),
        // Accepted, but out of scope: a failure.
        line({ scopeViolation: true }),
        line({ falseReport: true }),
        line({ stoppedOnDenial: false }),
        line({ reworkRounds: 2 }),
        line({ accepted: false }),
        line({ stoppedOnDenial: true }),
      ].join("\n"),
    );
    expect(scores).toEqual([
      { provider: "claude", model: "claude-sonnet-5-5", successes: 3, total: 8 },
    ]);
  });

  it("merges effort and tier, and maps score drivers onto usage providers", () => {
    const scores = parseDispatchScores(
      [
        line({}, { provider: "claudeAgent", model: "claude-opus-5-5" }),
        line({}, { provider: "claude", model: "claude-opus-5-5" }),
        line({}, { provider: "deepseek", model: "deepseek-flash" }),
        line({}, { provider: "grokbot", model: "grok-bot" }),
      ].join("\n\n"),
    );
    expect(scores).toEqual([
      { provider: "claude", model: "claude-opus-5-5", successes: 2, total: 2 },
      { provider: "opencode", model: "deepseek-flash", successes: 1, total: 1 },
      { provider: "grokbot", model: "grok-bot", successes: 1, total: 1 },
    ]);
  });

  it("gives no scores for a file with a line that is not a score record", () => {
    expect(parseDispatchScores(`${line({})}\n{not json`)).toBeNull();
    expect(parseDispatchScores(`${line({})}\n{"accepted":true}`)).toBeNull();
    expect(parseDispatchScores("")).toEqual([]);
  });
});
