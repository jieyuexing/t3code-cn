// @effect-diagnostics nodeBuiltinImport:off -- `PluginHost.make` only has FileSystem and Path in its context, so the CLI runs through Node's execFile, whose `timeout` kills the child.
import * as NodeChildProcess from "node:child_process";

import {
  NeedsYouDueItem,
  NeedsYouOrphan,
  type NeedsYouGtd,
  type NeedsYouTopic,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fail } from "./PluginSlot.ts";

const CLI_TIMEOUT_MS = 8000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_DUE_DAYS = 30;
const DEFAULT_RECENT_DAYS = 14;
const UNIVERSE_BIN = "host/bin/universe";
const TOPICS_FILE = "wiki/gtd/inbox/topics.md";

const DueReport = Schema.Struct({
  overdue: Schema.Array(NeedsYouDueItem),
  upcoming: Schema.Array(NeedsYouDueItem),
});
const RecentReport = Schema.Struct({
  orphans: Schema.Array(NeedsYouOrphan),
  linked: Schema.Array(Schema.Unknown),
  privateCount: Schema.Number,
  reposScanned: Schema.Number,
});
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

/** One source of the digest failed; `reason` is the short line shown in the popup. */
class NeedsYouGtdSourceError extends Schema.TaggedError<NeedsYouGtdSourceError>()(
  "NeedsYouGtdSourceError",
  { reason: Schema.String },
) {}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);

const isSourceError = Schema.is(NeedsYouGtdSourceError);

const sourceFailed = (error: unknown) =>
  isSourceError(error) ? error : new NeedsYouGtdSourceError({ reason: describe(error) });

const runCli = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          `${cwd}/${UNIVERSE_BIN}`,
          args,
          { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, signal },
          (error, stdout) => {
            if (error === null) resolve(stdout);
            else reject(error.killed === true ? `timed out after ${CLI_TIMEOUT_MS}ms` : error);
          },
        );
      }),
    catch: sourceFailed,
  });

/** The lines of the `## 条目` section, which ends at the next `## ` heading (the frozen box). */
function entriesSection(markdown: string): ReadonlyArray<string> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## 条目");
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/**
 * Entries are read line by line rather than as YAML: the inbox is hand-edited, and one value with a bare
 * `: ` or a repeated key must not cost the rest. A repeated key keeps its last value.
 */
export function parseTopics(markdown: string): ReadonlyArray<NeedsYouTopic> {
  const entries: Array<Record<string, string>> = [];
  for (const line of entriesSection(markdown)) {
    const start = /^- topic:(.*)$/.exec(line);
    if (start !== null) {
      entries.push({ topic: unquote(start[1] ?? "") });
      continue;
    }
    const field = /^ {2}(thread|captured_at|status):(.*)$/.exec(line);
    const current = entries.at(-1);
    if (field !== null && current !== undefined) current[field[1]!] = unquote(field[2] ?? "");
  }
  return entries.flatMap((entry) =>
    entry.status === "pending" || entry.status === "started"
      ? [
          {
            topic: entry.topic ?? "",
            thread: entry.thread ?? "",
            capturedAt: entry.captured_at ?? "",
            status: entry.status,
          },
        ]
      : [],
  );
}

/**
 * The GTD digest of a universe-repo project, read from its own CLI and inbox file. Nothing is written, and a
 * source that fails only empties its own list, so the digest never blocks the rest of the needs-you popup.
 */
export const readNeedsYouGtd = Effect.fn("NeedsYouGtd.read")(function* (input: {
  readonly cwd: string;
  readonly dueDays?: number;
  readonly recentDays?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scannedAt = DateTime.formatIso(yield* DateTime.now);
  const isDirectory = yield* fs.stat(input.cwd).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  if (!path.isAbsolute(input.cwd) || !isDirectory) {
    return yield* fail("invalid-input", "cwd must be an existing absolute directory");
  }

  const hasCli = yield* fs
    .exists(path.join(input.cwd, UNIVERSE_BIN))
    .pipe(Effect.orElseSucceed(() => false));
  const topicsPath = path.join(input.cwd, TOPICS_FILE);
  const hasTopics = yield* fs.exists(topicsPath).pipe(Effect.orElseSucceed(() => false));

  const source = <A>(label: string, effect: Effect.Effect<A, NeedsYouGtdSourceError>, empty: A) =>
    effect.pipe(
      Effect.map((value) => ({ value, error: undefined })),
      Effect.catch((error) => Effect.succeed({ value: empty, error: `${label}: ${error.reason}` })),
    );

  const [due, recent, topics] = yield* Effect.all(
    [
      source(
        "due",
        hasCli
          ? runCli(input.cwd, [
              "due",
              "--days",
              String(input.dueDays ?? DEFAULT_DUE_DAYS),
              "--json",
            ]).pipe(Effect.flatMap(decodeJson(DueReport)), Effect.mapError(sourceFailed))
          : Effect.succeed(null),
        null,
      ),
      source(
        "recent",
        hasCli
          ? runCli(input.cwd, [
              "recent",
              "--days",
              String(input.recentDays ?? DEFAULT_RECENT_DAYS),
              "--json",
            ]).pipe(Effect.flatMap(decodeJson(RecentReport)), Effect.mapError(sourceFailed))
          : Effect.succeed(null),
        null,
      ),
      source(
        "topics",
        hasTopics
          ? fs
              .readFileString(topicsPath)
              .pipe(Effect.map(parseTopics), Effect.mapError(sourceFailed))
          : Effect.succeed([] as ReadonlyArray<NeedsYouTopic>),
        [] as ReadonlyArray<NeedsYouTopic>,
      ),
    ],
    { concurrency: "unbounded" },
  );

  return {
    available: hasCli || hasTopics,
    overdue: due.value?.overdue ?? [],
    upcoming: due.value?.upcoming ?? [],
    topics: topics.value,
    orphans: recent.value?.orphans ?? [],
    recentLinkedCount: recent.value?.linked.length ?? 0,
    privateCount: recent.value?.privateCount ?? 0,
    reposScanned: recent.value?.reposScanned ?? 0,
    errors: [due.error, recent.error, topics.error].filter((error) => error !== undefined),
    scannedAt,
  } satisfies NeedsYouGtd;
});
