import {
  USAGE_CONTRACT_VERSION,
  UsageSummary,
  type EnvironmentId,
  type UsageDay,
  type UsageSpeedRow,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";
import {
  addToBins,
  binsMedian,
  binsToPairs,
  mergeDispatchScores,
  rankSpeedRows,
  speedRowKey,
  splitSparseRows,
} from "./usageSpeed.ts";

const pairsOf = (values: readonly number[]) => {
  const bins = new Map<number, number>();
  for (const value of values) addToBins(bins, value);
  return binsToPairs(bins);
};

function row(overrides: Partial<UsageSpeedRow> = {}): UsageSpeedRow {
  const rates = Array.from({ length: 30 }, () => 100);
  return {
    provider: "claude",
    model: "claude-fable-5",
    sourcePath: "/claude",
    outputTokens: 60_000,
    firstMs: 1_000,
    lastMs: 2_000,
    long: pairsOf(rates),
    all: pairsOf(rates),
    short: [],
    ...overrides,
  };
}

function environment(id: string, hostId: string, rows: readonly UsageSpeedRow[]): EnvironmentUsage {
  return {
    environmentId: id as EnvironmentId,
    label: id,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-07T00:00:00.000Z",
      timeZone: "UTC",
      sinceDay: "2026-08-01" as UsageDay,
      untilDay: "2026-08-31" as UsageDay,
      buckets: [],
      sources: [
        {
          fingerprint: {
            hostId,
            provider: "claude",
            resolvedHomePath: "/claude",
            volumeId: "vol",
          },
          status: "ok",
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 1,
          message: null,
        },
      ],
      pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
      requestSpeed: rows,
    },
  };
}

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);
const { requestSpeed: _requestSpeed, ...olderSummaryFields } = UsageSummary.fields;
const decodeOlderSummary = Schema.decodeUnknownSync(Schema.Struct(olderSummaryFields));

describe("request speed", () => {
  it("reads the median of merged histograms within the bin width", () => {
    const bins = new Map<number, number>();
    for (const value of [10, 50, 100, 120, 400]) addToBins(bins, value);
    expect(binsMedian(bins)).toBeCloseTo(100, -1);
    expect(binsMedian(new Map())).toBeNull();
  });

  it("counts a source read by two environments once and adds distinct sources", () => {
    const merged = mergeUsage(
      [
        environment("a", "host", [row()]),
        environment("b", "host", [row()]),
        environment("c", "other", [row()]),
      ],
      USAGE_CONTRACT_VERSION,
    );
    // Environments a and b read one directory; c reads another machine's.
    expect(merged.requestSpeed.map((entry) => [entry.model, entry.longRequests])).toEqual([
      ["claude-fable-5", 60],
    ]);
    expect(Math.abs(merged.requestSpeed[0]!.longRate! - 100)).toBeLessThan(2);
    expect(merged.requestSpeed[0]?.lowSample).toBe(false);
  });

  it("decodes with and without the field, and older schemas ignore it", () => {
    const encoded = JSON.parse(JSON.stringify(environment("a", "host", [row()]).summary)) as Record<
      string,
      unknown
    >;
    expect(decodeSummary(encoded).requestSpeed).toHaveLength(1);
    const { requestSpeed: _omitted, ...withoutField } = encoded;
    expect(decodeSummary(withoutField).requestSpeed).toBeUndefined();
    expect(decodeOlderSummary(encoded)).not.toHaveProperty("requestSpeed");
  });

  it("joins dispatch scores to rows, folding Antigravity effort suffixes into the scored model", () => {
    const rows = [
      row({ provider: "antigravity", model: "gemini-4-hydrogen-high", sourcePath: "/a" }),
      row({ provider: "antigravity", model: "claude-sonnet-5-5-high", sourcePath: "/a" }),
      row({ provider: "claude", model: "claude-sonnet-5-5" }),
      row({ provider: "opencode", model: "deepseek-flash", sourcePath: "/o" }),
      row({ provider: "claude", model: "claude-opus-5-5" }),
    ];
    const ranking = rankSpeedRows(
      rows,
      mergeDispatchScores([
        [
          { provider: "antigravity", model: "gemini-4-hydrogen", successes: 4, total: 4 },
          { provider: "antigravity", model: "claude-sonnet-5-5", successes: 1, total: 1 },
          { provider: "claude", model: "claude-sonnet-5-5", successes: 146, total: 159 },
          { provider: "opencode", model: "deepseek-flash", successes: 14, total: 14 },
        ],
        // The same file read through a second server is one record set, not two.
        [{ provider: "claude", model: "claude-sonnet-5-5", successes: 146, total: 159 }],
      ]),
    );
    expect(
      Object.fromEntries(
        ranking.map((entry) => [`${entry.provider}/${entry.model}`, entry.dispatch]),
      ),
    ).toEqual({
      "antigravity/gemini-4-hydrogen": { successes: 4, total: 4 },
      "antigravity/claude-sonnet-5-5": { successes: 1, total: 1 },
      "claude/claude-sonnet-5-5": { successes: 146, total: 159 },
      "opencode/deepseek-flash": { successes: 14, total: 14 },
      "claude/claude-opus-5-5": null,
    });
  });
  it("folds Antigravity effort and route variants of one model into one row", () => {
    const longOf = (count: number, rate: number) => pairsOf(Array.from({ length: count }, () => rate));
    const rows = [
      row({ provider: "antigravity", model: "gemini-4-hydrogen", long: longOf(109, 100) }),
      row({ provider: "antigravity", model: "gemini-4-hydrogen-high", long: longOf(105, 100) }),
      row({ provider: "antigravity", model: "gemini-4-argon-high", long: longOf(69, 50) }),
      row({ provider: "antigravity", model: "gemini-4-argon-trial", long: longOf(19, 50) }),
      row({ provider: "antigravity", model: "gemini-pro-orchestrator-neon", long: longOf(8, 50) }),
      row({ provider: "antigravity", model: "gemini-4-neon", long: longOf(88, 50) }),
      // Only Antigravity names its models per effort; elsewhere a suffix is part of the id.
      row({ provider: "opencode", model: "model-high", long: longOf(30, 50) }),
    ];
    const ranking = rankSpeedRows(rows);
    const longByModel = Object.fromEntries(
      ranking.map((entry) => [`${entry.provider}/${entry.model}`, entry.longRequests]),
    );
    expect(longByModel).toEqual({
      "antigravity/gemini-4-hydrogen": 214,
      "antigravity/gemini-4-argon": 88,
      "antigravity/gemini-pro-orchestrator-neon": 8,
      "antigravity/gemini-4-neon": 88,
      "opencode/model-high": 30,
    });
    // The merged row does not depend on which variant came first.
    const reversed = rankSpeedRows([...rows].reverse());
    expect(reversed.map(speedRowKey).toSorted()).toEqual(ranking.map(speedRowKey).toSorted());
  });

  it("keeps fast tiers apart from the standard tier when folding variants", () => {
    const ranking = rankSpeedRows([
      row({ provider: "antigravity", model: "gemini-4-argon-high" }),
      row({ provider: "antigravity", model: "gemini-4-argon-trial", tier: "fast" }),
    ]);
    expect(ranking.map((entry) => entry.tier)).toHaveLength(2);
    expect(new Set(ranking.map((entry) => entry.tier))).toEqual(new Set([undefined, "fast"]));
  });

  it("splits off rows with fewer than 20 long requests, unless every row is that few", () => {
    const longOf = (count: number) => pairsOf(Array.from({ length: count }, () => 100));
    const ranking = rankSpeedRows([
      row({ model: "a", long: longOf(20) }),
      row({ model: "b", long: longOf(19) }),
      row({ model: "c", long: [] }),
    ]);
    const split = splitSparseRows(ranking);
    expect(split.solid.map((entry) => entry.model)).toEqual(["a"]);
    expect(split.sparse.map((entry) => entry.model)).toEqual(["b", "c"]);

    const sparseOnly = splitSparseRows(ranking.filter((entry) => entry.lowSample));
    expect(sparseOnly.solid.map((entry) => entry.model)).toEqual(["b", "c"]);
    expect(sparseOnly.sparse).toEqual([]);
  });
});
