import type { SpeedRanking } from "@t3tools/shared/usageSpeed";

/** Tokens per second: one decimal below 100, whole numbers above. */
export function formatRate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

export function formatSeconds(value: number): string {
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} s`;
}

export function speedModelLabel(row: Pick<SpeedRanking, "model" | "tier">): string {
  return row.tier === undefined ? row.model : `${row.model} (${row.tier})`;
}

/** The rate a row's bar shows: long-output speed, else every request's speed, and whether it is thin. */
export function speedBarValue(row: SpeedRanking): { value: number; thin: boolean } {
  return row.longRate === null
    ? { value: row.allRate ?? 0, thin: true }
    : { value: row.longRate, thin: row.lowSample };
}

/** Bar widths as a share of the fastest bar. */
export function speedBarShares(rows: readonly SpeedRanking[]): number[] {
  const values = rows.map((row) => speedBarValue(row).value);
  const peak = Math.max(0, ...values);
  return values.map((value) => (peak > 0 ? value / peak : 0));
}

export function speedDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}
