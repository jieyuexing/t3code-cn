import { isListedThreadLineage } from "@t3tools/contracts";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import * as DateTime from "effect/DateTime";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";

export type PendingThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingUserInputAt"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "blockedOnThreadWait"
  | "runtime"
  | "latestRun"
> & { readonly source: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest"> };

export type PendingThreadStatus =
  | "input"
  | "approval"
  | "request"
  | "failed"
  | "done"
  | "waiting"
  | "working";

export interface PendingThread {
  readonly threadId: string;
  readonly title: string;
  readonly project: string | null;
  readonly status: PendingThreadStatus;
  readonly request: { readonly kind: string; readonly createdAt: string } | null;
  readonly lastTurnCompletedAt: string | null;
  /** When the thread started waiting: its open question or request, else its last finished turn. */
  readonly waitingSince: string | null;
}

// The sidebar's own classification; a usage limit needs the user as much as a failure does.
const STATUS: Readonly<Record<ReturnType<typeof resolveSidebarThreadStatus>, PendingThreadStatus>> =
  {
    input: "input",
    approval: "approval",
    request: "request",
    failed: "failed",
    limited: "failed",
    ready: "done",
    waiting: "waiting",
    working: "working",
    preparing: "working",
  };

/** The environment's top-level threads still in play: not archived, settled or snoozed, as the sidebar lists them. */
export function pendingThreads(input: {
  readonly shells: ReadonlyArray<PendingThreadShell>;
  readonly environmentId: EnvironmentId;
  readonly projectNames: ReadonlyMap<ProjectId, string>;
  readonly now: string;
}): ReadonlyArray<PendingThread> {
  return input.shells
    .filter(
      (thread) =>
        thread.environmentId === input.environmentId &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.settledOverride !== "settled" &&
        !effectiveSnoozed(thread, { now: input.now }),
    )
    .map((thread) => {
      const request = thread.source.pendingRuntimeRequest;
      const lastTurnCompletedAt = thread.latestRun?.completedAt ?? null;
      const requestAt = request === null ? null : DateTime.formatIso(request.createdAt);
      return {
        threadId: thread.id,
        title: thread.title,
        project: input.projectNames.get(thread.projectId) ?? null,
        status: STATUS[resolveSidebarThreadStatus(thread)],
        request:
          request === null
            ? null
            : { kind: request.kind, createdAt: DateTime.formatIso(request.createdAt) },
        lastTurnCompletedAt,
        waitingSince: requestAt ?? thread.pendingUserInputAt ?? lastTurnCompletedAt,
      };
    });
}

const REPLY_MAX_CHARS = 60_000;
// The bridge drops a message over 64K characters once the text is JSON-escaped.
const REPLY_MAX_ENCODED_CHARS = 64_000;

/** A reply cut to what one bridge message can carry. The tail stays: what a reply asks of the user comes last. */
export function clipReply(text: string): { readonly text: string; readonly truncated: boolean } {
  let clipped = text.slice(-REPLY_MAX_CHARS);
  const overflow = JSON.stringify(clipped).length - REPLY_MAX_ENCODED_CHARS;
  if (overflow > 0) clipped = clipped.slice(overflow);
  return { text: clipped, truncated: clipped.length < text.length };
}
