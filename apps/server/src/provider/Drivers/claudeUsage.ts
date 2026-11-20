import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude Code repeats a message's `dedupeKey` for each assistant content block.
 * Subagent blocks can progress from stream-start to final usage, so callers
 * must count each key once using the maximum of each token channel.
 */
/**
 * A request starts at the last `user` entry before its message (the prompt or a tool result);
 * attachments and other entries sit between and would shorten it.
 */
export const ClaudeScanState = Schema.Struct({
  lastUserMs: Schema.mutableKey(Schema.NullOr(Schema.Finite)),
});
export type ClaudeScanState = typeof ClaudeScanState.Type;

export const initialClaudeScanState = (): ClaudeScanState => ({ lastUserMs: null });

export function parseClaudeLine(
  line: string,
  state: ClaudeScanState = initialClaudeScanState(),
): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseClaudeRecord(parsed, state);
}

// Claude Code writes `type` near the start of a line and the entry's own `timestamp` right after its
// `uuid`; the large tool results of a user line sit between and after them.
const TYPE_SCAN_LENGTH = 400;
const USER_TYPE = Buffer.from('"type":"user"');
const TIMESTAMP_KEY = Buffer.from('"timestamp":"');
const UUID_BEFORE_TIMESTAMP = /"uuid":"[0-9a-f-]{36}",$/;
const QUOTE = 0x22;

/** Dates a `user` line from its bytes without decoding it; undefined sends the line to the parser. */
function parseClaudeBytes(
  line: Buffer,
  state: ClaudeScanState,
): readonly UsageRecord[] | undefined {
  if (!line.subarray(0, TYPE_SCAN_LENGTH).includes(USER_TYPE)) return undefined;
  const key = line.indexOf(TIMESTAMP_KEY);
  if (key < 60 || !UUID_BEFORE_TIMESTAMP.test(line.toString("latin1", key - 60, key)))
    return undefined;
  const start = key + TIMESTAMP_KEY.length;
  const end = line.indexOf(QUOTE, start);
  const timestampMs = end === -1 ? null : parseTimestampMs(line.toString("latin1", start, end));
  if (timestampMs === null) return undefined;
  state.lastUserMs = timestampMs;
  return [];
}

function cacheCreation1h(usage: Record<string, unknown>): { cacheCreation1hTokens?: number } {
  const split = usage["cache_creation"];
  if (typeof split !== "object" || split === null) return {};
  const tokens = tokenCount((split as Record<string, unknown>)["ephemeral_1h_input_tokens"]);
  return tokens > 0 ? { cacheCreation1hTokens: tokens } : {};
}

function parseClaudeRecord(parsed: unknown, state: ClaudeScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  if (record["type"] === "user") {
    state.lastUserMs = parseTimestampMs(record["timestamp"]) ?? state.lastUserMs;
    return [];
  }
  if (record["type"] !== "assistant") return [];

  const message = record["message"];
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return [];

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  const executor: UsageRecord = {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    ...cacheCreation1h(usageRecord),
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
    ...(state.lastUserMs !== null && state.lastUserMs <= timestampMs
      ? { request: { startMs: state.lastUserMs, endMs: timestampMs } }
      : {}),
  };

  // Top-level `usage` is the executor's alone. Advisor calls run on another model at its own rates
  // and appear only in `iterations`, so each one is its own record under that model.
  const records = [executor];
  const iterations: readonly unknown[] = Array.isArray(usageRecord["iterations"])
    ? usageRecord["iterations"]
    : [];
  for (const [index, iteration] of iterations.entries()) {
    if (typeof iteration !== "object" || iteration === null) continue;
    const advisor = iteration as Record<string, unknown>;
    if (advisor["type"] !== "advisor_message") continue;

    const advisorModel = typeof advisor["model"] === "string" ? advisor["model"] : "";
    if (advisorModel.length === 0 || advisorModel === CLAUDE_SYNTHETIC_MODEL) continue;

    records.push({
      provider: "claude",
      timestampMs,
      model: advisorModel,
      sessionId: executor.sessionId,
      totals: {
        uncachedInputTokens: tokenCount(advisor["input_tokens"]),
        cachedInputTokens: tokenCount(advisor["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(advisor["cache_creation_input_tokens"]),
        outputTokens: tokenCount(advisor["output_tokens"]),
        reasoningTokens: 0,
      },
      ...cacheCreation1h(advisor),
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

export const claudeUsageFormat: TranscriptUsageFormat<ClaudeScanState> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  // User entries carry no usage; they date the start of the next request.
  usageMarkers: ['"usage"', '"type":"user"'],
  parseLine: parseClaudeLine,
  parseBytes: parseClaudeBytes,
  parseProjected: parseClaudeRecord,
  state: { initial: initialClaudeScanState, schema: ClaudeScanState },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.homePath.trim();
    const home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
