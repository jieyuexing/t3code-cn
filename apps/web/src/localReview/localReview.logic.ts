import type { LocalReviewCommit, LocalReviewDirty, LocalReviewRepo } from "@t3tools/contracts";
import type { ReviewDiffFileStat } from "@t3tools/contracts";

import type { RelativeTimeState } from "../timestampFormat";

export const PAGE_SIZE = 50;
export const ALL_REPOS = "";

export const shortHash = (hash: string) => hash.slice(0, 7);

/** The message after its subject paragraph. */
export const commitBody = (commit: LocalReviewCommit) =>
  commit.message
    .split(/\n\s*\n/)
    .slice(1)
    .join("\n\n")
    .trim();

export const isMerge = (commit: LocalReviewCommit) => commit.parents.length > 1;

export const repoLabel = (repos: ReadonlyArray<LocalReviewRepo>, path: string) => {
  const name = repos.find((repo) => repo.path === path)?.name ?? path;
  return name.slice(name.lastIndexOf("/") + 1);
};

export type Selection =
  | { readonly kind: "commit"; readonly repo: string; readonly hash: string }
  | { readonly kind: "dirty"; readonly repo: string };

export const selectionKey = (selection: Selection) =>
  selection.kind === "commit" ? `${selection.repo}|${selection.hash}` : `${selection.repo}|dirty`;

export function listSelections(
  dirty: ReadonlyArray<LocalReviewDirty>,
  commits: ReadonlyArray<LocalReviewCommit>,
): ReadonlyArray<Selection> {
  return [
    ...dirty.map((entry) => ({ kind: "dirty" as const, repo: entry.repo })),
    ...commits.map((commit) => ({
      kind: "commit" as const,
      repo: commit.repo,
      hash: commit.hash,
    })),
  ];
}

export function relativeLabel(state: RelativeTimeState): string {
  if (state.status !== "relative") return "";
  if (state.suffix === null) return "刚刚";
  const amount = Number.parseInt(state.value, 10);
  const unit = state.value.endsWith("d") ? "天" : state.value.endsWith("h") ? "小时" : "分钟";
  return `${amount} ${unit}前`;
}

const STATUS_LABELS: Readonly<Record<NonNullable<ReviewDiffFileStat["changeType"]>, string>> = {
  new: "新增",
  deleted: "删除",
  change: "修改",
  "rename-pure": "改名",
  "rename-changed": "改名并修改",
};

export const fileStatusLabel = (file: ReviewDiffFileStat) =>
  STATUS_LABELS[file.changeType ?? "change"];
