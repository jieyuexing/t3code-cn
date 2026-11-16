import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitLogListInput = Schema.Struct({
  repo: Schema.optionalKey(TrimmedNonEmptyString),
  limit: Schema.optionalKey(PositiveInt),
  query: Schema.optionalKey(Schema.String),
});
export type GitLogListInput = typeof GitLogListInput.Type;

export const GitLogRepo = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
});
export type GitLogRepo = typeof GitLogRepo.Type;

export const GitLogCommit = Schema.Struct({
  hash: Schema.String,
  parents: Schema.Array(Schema.String),
  subject: Schema.String,
  author: Schema.String,
  committedAt: IsoDateTime,
  refs: Schema.Array(Schema.String),
});
export type GitLogCommit = typeof GitLogCommit.Type;

export const GitLogListResult = Schema.Struct({
  repos: Schema.Array(GitLogRepo),
  repo: Schema.String,
  commits: Schema.Array(GitLogCommit),
  hasMore: Schema.Boolean,
});
export type GitLogListResult = typeof GitLogListResult.Type;

export class GitLogError extends Schema.TaggedError<GitLogError>()("GitLogError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git log failed in ${this.operation}: ${this.detail}`;
  }
}
