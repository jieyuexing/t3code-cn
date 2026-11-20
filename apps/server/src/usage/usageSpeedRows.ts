import type { UsageSpeedRow } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import {
  SPEED_LONG_OUTPUT_TOKENS,
  SPEED_SHORT_MAX_OUTPUT_TOKENS,
  addToBins,
  binsToPairs,
  speedSample,
  type SpeedBins,
} from "@t3tools/shared/usageSpeed";

interface Row {
  readonly provider: UsageRecord["provider"];
  readonly model: string;
  readonly tier: "fast" | "ultrafast" | undefined;
  readonly source: string;
  readonly long: SpeedBins;
  readonly all: SpeedBins;
  readonly short: SpeedBins;
  outputTokens: number;
  firstMs: number;
  lastMs: number;
}

/** Collects per-request output speed from records that carry a request span. */
export class UsageSpeedAccumulator {
  readonly #rows = new Map<string, Row>();
  // Records of one model arrive together, so the last row usually serves the next.
  #last: Row | undefined;

  add(record: UsageRecord, source: string): void {
    if (record.request === undefined) return;
    const sample = speedSample(
      record.totals.outputTokens,
      record.request.startMs,
      record.request.endMs,
    );
    if (sample === null) return;
    const tier = record.speed === "standard" ? undefined : record.speed;
    let row = this.#last;
    if (
      row?.provider !== record.provider ||
      row.model !== record.model ||
      row.tier !== tier ||
      row.source !== source
    ) {
      const key = JSON.stringify([record.provider, record.model, tier ?? null, source]);
      row = this.#rows.get(key);
      if (row === undefined) {
        row = {
          provider: record.provider,
          model: record.model,
          tier,
          source,
          long: new Map(),
          all: new Map(),
          short: new Map(),
          outputTokens: 0,
          firstMs: record.request.endMs,
          lastMs: record.request.endMs,
        };
        this.#rows.set(key, row);
      }
      this.#last = row;
    }
    addToBins(row.all, sample.tokensPerSecond);
    if (sample.outputTokens >= SPEED_LONG_OUTPUT_TOKENS)
      addToBins(row.long, sample.tokensPerSecond);
    if (sample.outputTokens <= SPEED_SHORT_MAX_OUTPUT_TOKENS) addToBins(row.short, sample.seconds);
    row.outputTokens += sample.outputTokens;
    row.firstMs = Math.min(row.firstMs, record.request.endMs);
    row.lastMs = Math.max(row.lastMs, record.request.endMs);
  }

  finish(): UsageSpeedRow[] {
    return [...this.#rows.values()].map((row) => ({
      provider: row.provider,
      model: row.model,
      ...(row.tier === undefined ? {} : { tier: row.tier }),
      ...(row.source === "" ? {} : { sourcePath: row.source }),
      outputTokens: row.outputTokens,
      firstMs: row.firstMs,
      lastMs: row.lastMs,
      long: binsToPairs(row.long),
      all: binsToPairs(row.all),
      short: binsToPairs(row.short),
    }));
  }
}

/** Copies of one billed message share its start; the request ends when its last copy was written. */
export function mergeRequestSpans(
  held: UsageRecord["request"],
  copy: UsageRecord["request"],
): UsageRecord["request"] {
  if (held === undefined) return copy;
  if (copy === undefined || copy.endMs <= held.endMs) return held;
  return { startMs: held.startMs, endMs: copy.endMs };
}
