// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageDispatchScore } from "@t3tools/contracts";

// Score files name the driver; usage names the provider whose transcripts carry the model.
const USAGE_PROVIDER: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  deepseek: "opencode",
};

interface ScoreRecord {
  readonly accepted: boolean;
  readonly falseReport?: boolean;
  readonly scopeViolation?: boolean;
  readonly stoppedOnDenial?: boolean | null;
  readonly reworkRounds?: number | null;
  readonly executor: { readonly provider: string; readonly model: string };
}

// Copied from the dispatch scoring doc (QUOTA-DISPATCH.md in the host repo), which owns the formula.
const succeeded = (record: ScoreRecord) =>
  record.accepted &&
  !record.falseReport &&
  !record.scopeViolation &&
  record.stoppedOnDenial !== false &&
  (record.reworkRounds ?? 0) <= 1;

function isScoreRecord(value: unknown): value is ScoreRecord {
  if (typeof value !== "object" || value === null) return false;
  const { accepted, executor } = value as Partial<ScoreRecord>;
  return (
    typeof accepted === "boolean" &&
    typeof executor === "object" &&
    executor !== null &&
    typeof executor.provider === "string" &&
    typeof executor.model === "string"
  );
}

/** Null when any line is not a score record: a partial count would read as a true one. */
export function parseDispatchScores(jsonl: string): UsageDispatchScore[] | null {
  const counts = new Map<
    string,
    { provider: string; model: string; successes: number; total: number }
  >();
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isScoreRecord(record)) return null;
    const provider = USAGE_PROVIDER[record.executor.provider] ?? record.executor.provider;
    const key = `${provider}\u0000${record.executor.model}`;
    const entry = counts.get(key) ?? {
      provider,
      model: record.executor.model,
      successes: 0,
      total: 0,
    };
    entry.total += 1;
    if (succeeded(record)) entry.successes += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

/** Reads only an absolute path; anything unreadable shows no scores rather than stale or partial ones. */
export async function readDispatchScores(path: string): Promise<UsageDispatchScore[] | undefined> {
  if (!NodePath.isAbsolute(path)) return undefined;
  try {
    return parseDispatchScores(await NodeFSP.readFile(path, "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}
