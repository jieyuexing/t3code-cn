import type { GitLogCommit, ReviewDiffFileStat } from "@t3tools/contracts";

export const PAGE_SIZE = 100;
export const FILTER_DELAY_MS = 250;

export const isMerge = (commit: GitLogCommit) => commit.parents.length > 1;

const STATUS_LETTERS: Readonly<Record<NonNullable<ReviewDiffFileStat["changeType"]>, string>> = {
  new: "A",
  deleted: "D",
  change: "M",
  "rename-pure": "R",
  "rename-changed": "R",
};

export const statusLetter = (file: ReviewDiffFileStat) =>
  STATUS_LETTERS[file.changeType ?? "change"];

const SHORT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `MM-DD HH:mm` in local time. */
export function shortTime(iso: string): string {
  const parts = Object.fromEntries(
    SHORT_FORMAT.formatToParts(Date.parse(iso)).map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `YYYY-MM-DD HH:mm` in local time. */
export function fullTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const splitPath = (path: string): readonly [name: string, directory: string] => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? [path, ""] : [path.slice(slash + 1), path.slice(0, slash)];
};
