import { splitSparseRows, type SpeedRanking } from "@t3tools/shared/usageSpeed";

import { modelDisplayName, type ShareLang } from "./usageShareModel";

/** Tokens per second: one decimal below 100, whole numbers above. */
export function formatRate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

export function formatSeconds(value: number): string {
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} s`;
}

export function speedModelLabel(row: Pick<SpeedRanking, "model" | "tier">): string {
  const name = modelDisplayName(row.model);
  return row.tier === undefined ? name : `${name} (${row.tier})`;
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

/** The rows to list: those with few long samples wait behind a toggle, and `folded` counts them. */
export function foldSpeedRows(
  ranking: readonly SpeedRanking[],
  expanded: boolean,
): { readonly rows: readonly SpeedRanking[]; readonly folded: number } {
  const { solid, sparse } = splitSparseRows(ranking);
  return { rows: expanded ? [...solid, ...sparse] : solid, folded: sparse.length };
}

export function foldToggleLabel(folded: number, expanded: boolean, lang: ShareLang): string {
  if (lang === "zh") return expanded ? "收起样本少的行" : `另有 ${folded} 个样本少的行`;
  return expanded
    ? "Hide rows with few samples"
    : `${folded} more ${folded === 1 ? "row" : "rows"} with few samples`;
}
