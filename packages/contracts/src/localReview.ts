import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalReviewLogInput = Schema.Struct({
  part: Schema.Literals(["commits", "dirty"]),
  repo: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
});
export type LocalReviewLogInput = typeof LocalReviewLogInput.Type;

export const LocalReviewRepo = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
});
export type LocalReviewRepo = typeof LocalReviewRepo.Type;

export const LocalReviewCommit = Schema.Struct({
  repo: Schema.String,
  hash: Schema.String,
  parents: Schema.Array(Schema.String),
  subject: Schema.String,
  message: Schema.String,
  author: Schema.String,
  committedAt: IsoDateTime,
  refs: Schema.Array(Schema.String),
});
export type LocalReviewCommit = typeof LocalReviewCommit.Type;

export const LocalReviewDirty = Schema.Struct({
  repo: Schema.String,
  changeCount: NonNegativeInt,
});
export type LocalReviewDirty = typeof LocalReviewDirty.Type;

export const LocalReviewLogResult = Schema.Struct({
  repos: Schema.Array(LocalReviewRepo),
  commits: Schema.Array(LocalReviewCommit),
  dirty: Schema.Array(LocalReviewDirty),
  hasMore: Schema.Boolean,
});
export type LocalReviewLogResult = typeof LocalReviewLogResult.Type;

export class LocalReviewError extends Schema.TaggedError<LocalReviewError>()("LocalReviewError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Local review failed in ${this.operation}: ${this.detail}`;
  }
}
