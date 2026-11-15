import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const LocalReviewListInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  days: Schema.optionalKey(PositiveInt),
  includeUnchanged: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
  cursor: Schema.optionalKey(Schema.String),
});
export type LocalReviewListInput = typeof LocalReviewListInput.Type;

export const LocalReviewRequestHead = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  threadTitle: Schema.String,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  runCount: NonNegativeInt,
  origin: Schema.Literals(["user", "agent"]),
  childCount: NonNegativeInt,
  fileChangeCount: NonNegativeInt,
  commitCommandCount: NonNegativeInt,
});
export type LocalReviewRequestHead = typeof LocalReviewRequestHead.Type;

export const LocalReviewListResult = Schema.Struct({
  requests: Schema.Array(LocalReviewRequestHead),
  nextCursor: Schema.NullOr(Schema.String),
});
export type LocalReviewListResult = typeof LocalReviewListResult.Type;

export const LocalReviewGetInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type LocalReviewGetInput = typeof LocalReviewGetInput.Type;

export const LocalReviewSourceLayer = Schema.Literals([
  "checkpoint",
  "fileChange",
  "output",
  "range",
  "child",
]);
export type LocalReviewSourceLayer = typeof LocalReviewSourceLayer.Type;

export const LocalReviewFileState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("uncommitted") }),
  Schema.Struct({ kind: Schema.Literal("committed"), hash: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unknown") }),
]);
export type LocalReviewFileState = typeof LocalReviewFileState.Type;

export const LocalReviewFile = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  sources: Schema.Array(LocalReviewSourceLayer),
  commits: Schema.Array(Schema.String),
  state: LocalReviewFileState,
});
export type LocalReviewFile = typeof LocalReviewFile.Type;

export const LocalReviewCommit = Schema.Struct({
  repo: Schema.String,
  hash: Schema.String,
  subject: Schema.String,
  time: Schema.Number,
  role: Schema.Literals(["output", "range"]),
  orphan: Schema.Boolean,
  mergedAs: Schema.NullOr(Schema.String),
  mergedVia: Schema.NullOr(Schema.Literals(["patchId", "title"])),
  alsoIn: Schema.Array(Schema.String),
  fromChild: Schema.Boolean,
});
export type LocalReviewCommit = typeof LocalReviewCommit.Type;

export const LocalReviewBlindSpot = Schema.Literals(["output-truncated", "git-budget"]);
export type LocalReviewBlindSpot = typeof LocalReviewBlindSpot.Type;

export const LocalReviewGetResult = Schema.Struct({
  head: LocalReviewRequestHead,
  files: Schema.Array(LocalReviewFile),
  commits: Schema.Array(LocalReviewCommit),
  deliverables: Schema.Array(Schema.String),
  mentionedCommits: NonNegativeInt,
  clearedWorktrees: NonNegativeInt,
  omittedFiles: NonNegativeInt,
  blindSpots: Schema.Array(LocalReviewBlindSpot),
  gitCalls: NonNegativeInt,
  complete: Schema.Boolean,
});
export type LocalReviewGetResult = typeof LocalReviewGetResult.Type;

export class LocalReviewError extends Schema.TaggedError<LocalReviewError>()("LocalReviewError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Local review failed in ${this.operation}: ${this.detail}`;
  }
}
