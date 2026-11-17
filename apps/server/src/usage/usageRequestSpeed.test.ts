// @effect-diagnostics nodeBuiltinImport:off - writes real transcript files so both parse paths run
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import type { UsageRecord, UsageRequestSpan } from "@t3tools/provider-core/server/usage";
import * as DateTime from "effect/DateTime";
import { rankSpeedRows, speedSample } from "@t3tools/shared/usageSpeed";

import { UsageAggregator } from "./usageAggregation.ts";
import { dedupeWithinFile } from "./usageScanCache.ts";
import { TEST_FORMATS } from "./usageTestFormats.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-speed-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const BASE = Date.parse("2026-08-01T10:00:00Z");
const at = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(BASE + seconds * 1000));
const lines = (...entries: readonly unknown[]) =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
const READ_MODES = [
  { mode: "buffered", streamingThresholdBytes: Infinity },
  { mode: "streaming", streamingThresholdBytes: 0 },
];

describe("Claude request spans", () => {
  const assistant = (id: string, seconds: number, outputTokens: number, block: string) => ({
    type: "assistant",
    timestamp: at(seconds),
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id,
      model: "claude-fable-5",
      content: [{ type: block }],
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  });

  it.each(READ_MODES)(
    "starts at the last user entry, not an attachment, and ends at the last block ($mode)",
    async (options) => {
      const path = NodePath.join(dir, "claude.jsonl");
      await NodeFSP.writeFile(
        path,
        lines(
          { type: "user", timestamp: at(0), message: { role: "user", content: "go" } },
          { type: "attachment", timestamp: at(8), attachment: { type: "hook_success" } },
          assistant("msg_1", 10, 50, "thinking"),
          assistant("msg_1", 14, 400, "text"),
          { type: "user", timestamp: at(20), message: { role: "user", content: [] } },
          assistant("msg_2", 25, 100, "text"),
        ),
      );

      const result = await readTranscriptRecords(path, TEST_FORMATS.claude, undefined, options);
      assert.isNotNull(result);
      const records = dedupeWithinFile(result.records);
      assert.deepStrictEqual(
        records.map((record) => [record.dedupeKey, record.request]),
        [
          ["msg_1:req_msg_1", { startMs: BASE, endMs: BASE + 14_000 }],
          ["msg_2:req_msg_2", { startMs: BASE + 20_000, endMs: BASE + 25_000 }],
        ],
      );
    },
  );

  it("dates a user entry by its own timestamp when tool data nests another", async () => {
    const path = NodePath.join(dir, "claude-nested.jsonl");
    await NodeFSP.writeFile(
      path,
      lines(
        {
          type: "user",
          // Nested data ahead of the entry's own timestamp, and after it.
          message: { role: "user", content: [{ type: "tool_result", timestamp: at(500) }] },
          timestamp: at(0),
          toolUseResult: { timestamp: at(900) },
        },
        assistant("msg_1", 12, 300, "text"),
        {
          type: "user",
          message: { role: "user", content: "next" },
          timestamp: at(20),
          toolUseResult: { timestamp: at(900) },
        },
        assistant("msg_2", 31, 300, "text"),
      ),
    );

    const result = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(result);
    assert.deepStrictEqual(
      result.records.map((record) => record.request),
      [
        { startMs: BASE, endMs: BASE + 12_000 },
        { startMs: BASE + 20_000, endMs: BASE + 31_000 },
      ],
    );
  });

  it("resumes with the last user entry carried in the scan state", async () => {
    const path = NodePath.join(dir, "claude-resume.jsonl");
    await NodeFSP.writeFile(
      path,
      lines({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }),
    );
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    await NodeFSP.appendFile(path, lines(assistant("msg_1", 12, 300, "text")));
    const grown = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(grown);
    assert.isTrue(grown.resumed);
    assert.deepStrictEqual(grown.records[0]?.request, { startMs: BASE, endMs: BASE + 12_000 });
  });
});

describe("Codex request spans", () => {
  const item = (seconds: number, type: string, extra: object = {}) => ({
    timestamp: at(seconds),
    ordinal: seconds,
    type: type === "task_started" ? "event_msg" : "response_item",
    payload: { type, ...extra },
  });
  const tokenCount = (
    seconds: number,
    input: number,
    output: number,
    totalInput: number,
    totalOutput: number,
  ) => ({
    timestamp: at(seconds),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, output_tokens: output },
        total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput },
      },
    },
  });
  const setup = [
    { timestamp: at(0), type: "session_meta", payload: { type: "session_meta", id: "codex-1" } },
    { timestamp: at(0), type: "turn_context", payload: { type: "turn_context", model: "gpt-6" } },
  ];

  it.each(READ_MODES)(
    "dates each request from its start to its last output item ($mode)",
    async (options) => {
      const path = NodePath.join(dir, "rollout.jsonl");
      await NodeFSP.writeFile(
        path,
        lines(
          ...setup,
          item(1, "task_started"),
          item(2, "message", { role: "developer" }),
          item(3, "message", { role: "user" }),
          item(8, "reasoning"),
          item(9, "function_call"),
          tokenCount(9, 100, 400, 100, 400),
          item(11, "function_call_output"),
          item(25, "message", { role: "assistant" }),
          tokenCount(25, 200, 800, 300, 1200),
        ),
      );

      const result = await readTranscriptRecords(path, TEST_FORMATS.codex, undefined, options);
      assert.isNotNull(result);
      assert.deepStrictEqual(
        result.records.map((record) => record.request),
        [
          { startMs: BASE + 3_000, endMs: BASE + 9_000 },
          { startMs: BASE + 11_000, endMs: BASE + 25_000 },
        ],
      );
    },
  );

  it("counts a repeated token_count once and does not carry its timing into the next request", async () => {
    const path = NodePath.join(dir, "rollout-repeat.jsonl");
    await NodeFSP.writeFile(
      path,
      lines(
        ...setup,
        item(1, "message", { role: "user" }),
        item(5, "function_call"),
        tokenCount(5, 100, 400, 100, 400),
        // Re-emitted counters do not report a request, but they still end the one in flight.
        item(6, "reasoning"),
        tokenCount(6, 100, 400, 100, 400),
        item(20, "function_call_output"),
        item(30, "message", { role: "assistant" }),
        tokenCount(30, 200, 800, 300, 1200),
      ),
    );

    const result = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(result);
    assert.deepStrictEqual(
      result.records.map((record) => [record.totals.outputTokens, record.request]),
      [
        [400, { startMs: BASE + 1_000, endMs: BASE + 5_000 }],
        [800, { startMs: BASE + 20_000, endMs: BASE + 30_000 }],
      ],
    );
  });
});

describe("request speed rows", () => {
  const request = (startSeconds: number, endSeconds: number): UsageRequestSpan => ({
    startMs: BASE + startSeconds * 1000,
    endMs: BASE + endSeconds * 1000,
  });
  const record = (overrides: Partial<UsageRecord>): UsageRecord => ({
    provider: "claude",
    timestampMs: BASE,
    model: "claude-fable-5",
    sessionId: "s",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 2000,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  });
  const options = {
    timeZone: "UTC",
    sinceDay: "2026-08-01",
    untilDay: "2026-08-01",
    rates: new Map(),
  };

  it("ends a message's request at its last copy and ranks by long-output speed", () => {
    const aggregator = new UsageAggregator(options);
    aggregator.add(record({ dedupeKey: "a", request: request(0, 10) }), "/home");
    // Same tokens, so only the end differs.
    aggregator.add(record({ dedupeKey: "a", request: request(0, 20) }), "/home");
    aggregator.add(record({ dedupeKey: "b", request: request(0, 20), model: "slow" }), "/home");
    // Below 100 output tokens and outside 0.5 to 900 seconds are not requests worth timing.
    aggregator.add(
      record({
        request: request(0, 5),
        totals: { ...record({}).totals, outputTokens: 99 },
      }),
      "/home",
    );
    aggregator.add(record({ request: request(0, 901) }), "/home");
    aggregator.add(record({ request: request(0, 0.4) }), "/home");
    const { requestSpeed } = aggregator.finish();

    assert.strictEqual(requestSpeed.length, 2);
    const ranking = rankSpeedRows(requestSpeed);
    assert.deepStrictEqual(
      ranking.map((row) => [row.model, row.requests, row.longRequests]),
      [
        ["claude-fable-5", 1, 1],
        ["slow", 1, 1],
      ],
    );
    // 2000 tokens over 20 seconds, within the histogram's bin width.
    assert.closeTo(ranking[0]!.longRate!, 100, 2);
    assert.isTrue(ranking[0]!.lowSample);
  });

  it("rejects spans that carry no usable duration", () => {
    assert.isNull(speedSample(1000, BASE, BASE));
    assert.isNull(speedSample(50, BASE, BASE + 10_000));
    assert.strictEqual(speedSample(1000, BASE, BASE + 10_000)?.tokensPerSecond, 100);
  });
});
