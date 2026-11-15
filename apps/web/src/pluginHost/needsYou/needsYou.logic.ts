import type { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";

import {
  pendingThreads,
  type PendingThread,
  type PendingThreadShell,
  type PendingThreadStatus,
} from "../pendingThreads";

export type NeedsYouKind = "reply" | "approval" | "question" | "request" | "failed";

export interface NeedsYouThread extends Omit<PendingThread, "project" | "status"> {
  readonly status: Exclude<PendingThreadStatus, "working">;
  readonly requestId: RuntimeRequestId | null;
}

export interface NeedsYouEntry {
  readonly thread: NeedsYouThread;
  readonly kind: NeedsYouKind;
  /** The first line of what waits on the user. */
  readonly text: string;
}

/** The text that tells a thread to take the recommendation it just wrote. */
export const FOLLOW_RECOMMENDATION = "按推荐";

export const KIND_LABELS: Readonly<Record<NeedsYouKind, string>> = {
  reply: "回复待决",
  approval: "审批",
  question: "提问",
  request: "访客请求",
  failed: "失败",
};

/** The environment's threads that may need the user: the native needs-attention states, plus finished or waiting threads whose last reply may carry a decision. */
export function needsYouThreads(input: {
  readonly shells: ReadonlyArray<PendingThreadShell>;
  readonly environmentId: EnvironmentId;
  readonly now: string;
}): ReadonlyArray<NeedsYouThread> {
  const requestIds = new Map<string, RuntimeRequestId>(
    input.shells.flatMap((shell) => {
      const request = shell.source.pendingRuntimeRequest;
      return request === null ? [] : [[shell.id, request.id] as const];
    }),
  );
  return pendingThreads({ ...input, projectNames: new Map() }).flatMap(
    ({ project: _project, status, ...thread }) =>
      status === "working"
        ? []
        : [{ ...thread, status, requestId: requestIds.get(thread.threadId) ?? null }],
  );
}

export const sameNeedsYouThreads = (
  left: ReadonlyArray<NeedsYouThread>,
  right: ReadonlyArray<NeedsYouThread>,
) => JSON.stringify(left) === JSON.stringify(right);

export type TextJob = {
  readonly key: string;
  readonly threadId: string;
  readonly source: "reply" | "question";
};

/** A reply stays as it is until the thread finishes another turn, a question until it is replaced. */
function jobOf(thread: NeedsYouThread): TextJob | null {
  if (thread.status === "done" || thread.status === "waiting") {
    return {
      key: `reply:${thread.threadId}@${thread.lastTurnCompletedAt ?? ""}`,
      threadId: thread.threadId,
      source: "reply",
    };
  }
  return thread.status === "input"
    ? {
        key: `question:${thread.threadId}@${thread.request?.createdAt ?? thread.waitingSince ?? ""}`,
        threadId: thread.threadId,
        source: "question",
      }
    : null;
}

/** The texts still to read from a transcript; what is in `texts` is not read again. */
export const missingTextJobs = (
  threads: ReadonlyArray<NeedsYouThread>,
  texts: Readonly<Record<string, string>>,
): ReadonlyArray<TextJob> =>
  threads.flatMap((thread) => {
    const job = jobOf(thread);
    return job === null || job.key in texts ? [] : [job];
  });

const NATIVE_TEXT = {
  approval: "等待审批",
  request: "等待回应",
  failed: "失败",
  input: "等待输入",
} as const;

/** Threads that wait on the user, longest first; a thread whose waiting start is unknown goes last. */
export function buildEntries(
  threads: ReadonlyArray<NeedsYouThread>,
  texts: Readonly<Record<string, string>>,
): NeedsYouEntry[] {
  const entries = threads.flatMap((thread): NeedsYouEntry[] => {
    if (thread.status === "done" || thread.status === "waiting") {
      const text = texts[jobOf(thread)?.key ?? ""] ?? "";
      return text === "" ? [] : [{ thread, kind: "reply", text }];
    }
    if (thread.status === "input") {
      const text = texts[jobOf(thread)?.key ?? ""] || NATIVE_TEXT.input;
      return [{ thread, kind: "question", text }];
    }
    return [{ thread, kind: thread.status, text: NATIVE_TEXT[thread.status] }];
  });
  const since = (entry: NeedsYouEntry) =>
    entry.thread.waitingSince === null ? Infinity : Date.parse(entry.thread.waitingSince);
  return entries.sort((a, b) => (since(a) < since(b) ? -1 : since(a) > since(b) ? 1 : 0));
}

/** How long it has waited: 刚刚, 25 分, 3 小时, 1 小时 40 分, 2 天 3 小时. */
export function formatWait(since: string | null, now: number): string {
  if (since === null) return "";
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} 天` : `${days} 天 ${hours % 24} 小时`;
}

/** Local 09:00 the next day. */
export const tomorrowMorning = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
