import type { UsageDispatchScore, UsageSpeedHistogram, UsageSpeedRow } from "@t3tools/contracts";

const BIN_RATIO = 1.02;
const BIN_OFFSET = 200;

/** Requests below this many output tokens say more about latency than speed. */
const SPEED_MIN_OUTPUT_TOKENS = 100;
export const SPEED_LONG_OUTPUT_TOKENS = 1000;
export const SPEED_SHORT_MAX_OUTPUT_TOKENS = 300;
/** Fewer long requests than this leaves the long-output speed noisy. */
export const SPEED_LOW_SAMPLE_LONG_REQUESTS = 20;
const MIN_REQUEST_SECONDS = 0.5;
const MAX_REQUEST_SECONDS = 900;

export interface SpeedSample {
  readonly outputTokens: number;
  readonly seconds: number;
  readonly tokensPerSecond: number;
}

/** Null when the request is too short, or its span too short or too long, to mean anything. */
export function speedSample(
  outputTokens: number,
  startMs: number,
  endMs: number,
): SpeedSample | null {
  const seconds = (endMs - startMs) / 1000;
  if (
    outputTokens < SPEED_MIN_OUTPUT_TOKENS ||
    !(seconds > MIN_REQUEST_SECONDS) ||
    !(seconds < MAX_REQUEST_SECONDS)
  ) {
    return null;
  }
  return { outputTokens, seconds, tokensPerSecond: outputTokens / seconds };
}

const speedBin = (value: number): number =>
  Math.max(0, Math.round(Math.log(value) / Math.log(BIN_RATIO)) + BIN_OFFSET);

const binValue = (bin: number): number => BIN_RATIO ** (bin - BIN_OFFSET);

export type SpeedBins = Map<number, number>;

export function addToBins(bins: SpeedBins, value: number): void {
  const bin = speedBin(value);
  bins.set(bin, (bins.get(bin) ?? 0) + 1);
}

function addPairsToBins(bins: SpeedBins, pairs: UsageSpeedHistogram): void {
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const bin = pairs[index]!;
    bins.set(bin, (bins.get(bin) ?? 0) + pairs[index + 1]!);
  }
}

export function binsToPairs(bins: SpeedBins): number[] {
  return [...bins].sort(([a], [b]) => a - b).flat();
}

/** Median of the bin centers, within one bin ratio (2%) of the exact median. */
export function binsMedian(bins: SpeedBins): number | null {
  const sorted = [...bins].sort(([a], [b]) => a - b);
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  const at = (rank: number) => {
    let seen = 0;
    for (const [bin, count] of sorted) {
      seen += count;
      if (rank < seen) return binValue(bin);
    }
    return binValue(sorted.at(-1)![0]);
  };
  return total % 2 === 1 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
}

const ANTIGRAVITY_VARIANT_SUFFIX = /(?:-(?:extra-low|low|medium|high|xhigh|trial))+$/;

/**
 * One model's name across rows. Antigravity names a model per effort ("gemini-4-hydrogen-high") and
 * per route ("gemini-4-argon-trial", which its own metadata labels "Gemini 4 Argon (High)").
 */
export function speedModel(provider: string, model: string): string {
  return provider === "antigravity" ? model.replace(ANTIGRAVITY_VARIANT_SUFFIX, "") : model;
}

/** Scores name a model once, whatever effort or route its transcripts name. */
function scoreKey(provider: string, model: string): string {
  return `${provider}\u0000${speedModel(provider, model)}`;
}

/** Merges per-environment score counts; a file two servers both read shows the same counts, not twice. */
export function mergeDispatchScores(
  lists: readonly (readonly UsageDispatchScore[])[],
): UsageDispatchScore[] {
  const merged = new Map<string, UsageDispatchScore>();
  for (const score of lists.flat()) {
    const key = scoreKey(score.provider, score.model);
    const held = merged.get(key);
    if (held === undefined || score.total > held.total) merged.set(key, score);
  }
  return [...merged.values()];
}

export interface SpeedRanking {
  readonly provider: string;
  readonly model: string;
  readonly tier: "fast" | "ultrafast" | undefined;
  readonly requests: number;
  readonly longRequests: number;
  readonly shortRequests: number;
  readonly outputTokens: number;
  readonly firstMs: number;
  readonly lastMs: number;
  /** Median tokens per second of requests with at least 1000 output tokens. */
  readonly longRate: number | null;
  /** Median tokens per second of every counted request. */
  readonly allRate: number | null;
  /** Median seconds of requests with 100 to 300 output tokens. */
  readonly shortSeconds: number | null;
  readonly lowSample: boolean;
  /** Dispatches of this model that succeeded, over all dispatched; null without a record. */
  readonly dispatch: { readonly successes: number; readonly total: number } | null;
}

export function speedRowKey(row: Pick<SpeedRanking, "provider" | "model" | "tier">): string {
  return JSON.stringify([row.provider, row.model, row.tier ?? null]);
}

/**
 * Splits off rows with too few long requests to rank fairly; they come back when samples pile up.
 * With nothing but such rows there is nothing to rank against, so none are split off.
 */
export function splitSparseRows<Row extends Pick<SpeedRanking, "lowSample">>(
  rows: readonly Row[],
): { readonly solid: readonly Row[]; readonly sparse: readonly Row[] } {
  const solid = rows.filter((row) => !row.lowSample);
  return solid.length === 0
    ? { solid: rows, sparse: [] }
    : { solid, sparse: rows.filter((row) => row.lowSample) };
}

/** Adds up rows of one model across sources and variants, then ranks by long-output speed, rows without one last. */
export function rankSpeedRows(
  rows: readonly UsageSpeedRow[],
  scores: readonly UsageDispatchScore[] = [],
): SpeedRanking[] {
  const scoreByModel = new Map(
    scores.map((score) => [scoreKey(score.provider, score.model), score]),
  );
  const grouped = new Map<
    string,
    {
      provider: string;
      model: string;
      tier: UsageSpeedRow["tier"];
      long: SpeedBins;
      all: SpeedBins;
      short: SpeedBins;
      outputTokens: number;
      firstMs: number;
      lastMs: number;
    }
  >();
  for (const row of rows) {
    const model = speedModel(row.provider, row.model);
    const key = speedRowKey({ provider: row.provider, model, tier: row.tier });
    let group = grouped.get(key);
    if (group === undefined) {
      group = {
        provider: row.provider,
        model,
        tier: row.tier,
        long: new Map(),
        all: new Map(),
        short: new Map(),
        outputTokens: 0,
        firstMs: row.firstMs,
        lastMs: row.lastMs,
      };
      grouped.set(key, group);
    }
    addPairsToBins(group.long, row.long);
    addPairsToBins(group.all, row.all);
    addPairsToBins(group.short, row.short);
    group.outputTokens += row.outputTokens;
    group.firstMs = Math.min(group.firstMs, row.firstMs);
    group.lastMs = Math.max(group.lastMs, row.lastMs);
  }
  const count = (bins: SpeedBins) => [...bins.values()].reduce((sum, value) => sum + value, 0);
  return [...grouped.values()]
    .map((group): SpeedRanking => {
      const longRequests = count(group.long);
      const score = scoreByModel.get(scoreKey(group.provider, group.model));
      return {
        provider: group.provider,
        model: group.model,
        tier: group.tier,
        requests: count(group.all),
        longRequests,
        shortRequests: count(group.short),
        outputTokens: group.outputTokens,
        firstMs: group.firstMs,
        lastMs: group.lastMs,
        longRate: binsMedian(group.long),
        allRate: binsMedian(group.all),
        shortSeconds: binsMedian(group.short),
        lowSample: longRequests < SPEED_LOW_SAMPLE_LONG_REQUESTS,
        dispatch: score === undefined ? null : { successes: score.successes, total: score.total },
      };
    })
    .filter((ranking) => ranking.requests > 0)
    .sort((a, b) => {
      if ((a.longRate === null) !== (b.longRate === null)) return a.longRate === null ? 1 : -1;
      return (b.longRate ?? b.allRate ?? 0) - (a.longRate ?? a.allRate ?? 0);
    });
}
