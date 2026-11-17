import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Sparse log-scale histogram as flat `[bin, count, bin, count, ...]` pairs; bins are defined by `@t3tools/shared/usageSpeed`. */
export const UsageSpeedHistogram = Schema.Array(Schema.Int);
export type UsageSpeedHistogram = typeof UsageSpeedHistogram.Type;

/**
 * Per-request output speed of one model on one source, over the requested window. Medians cannot be
 * merged across sources, so rows carry histograms that clients add up before reading a median.
 */
export const UsageSpeedRow = Schema.Struct({
  /** A plain string rather than UsageProviderKind, which this file must not import. */
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  /** Absent for standard; fast tiers run at their own speed. */
  tier: Schema.optional(Schema.Literals(["fast", "ultrafast"])),
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  outputTokens: NonNegativeInt,
  firstMs: Schema.Number,
  lastMs: Schema.Number,
  /** Output tokens per second of requests with at least 1000 output tokens. */
  long: UsageSpeedHistogram,
  /** Output tokens per second of every counted request. */
  all: UsageSpeedHistogram,
  /** Seconds of counted requests with at most 300 output tokens. */
  short: UsageSpeedHistogram,
});
export type UsageSpeedRow = typeof UsageSpeedRow.Type;

/** Dispatches of one model that an external score file records, and how many of them succeeded. */
export const UsageDispatchScore = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  successes: NonNegativeInt,
  total: NonNegativeInt,
});
export type UsageDispatchScore = typeof UsageDispatchScore.Type;
