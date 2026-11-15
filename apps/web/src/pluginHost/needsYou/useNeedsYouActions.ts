import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, type EnvironmentId, type ProviderApprovalDecision } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { newMessageId } from "~/lib/utils";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "~/types";

import { tomorrowMorning, type NeedsYouEntry } from "./needsYou.logic";

/** `null` when the command went through, else what to show on the row. */
function failureOf(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success") return null;
  if (isAtomCommandInterrupted(result)) return "已取消";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "请求失败";
}

/** What a row of the needs-you list does to its thread. */
export function useNeedsYouActions(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const quietly = { reportFailure: false };
  const snooze = useOrchestrationCommand(threadEnvironment.snooze, quietly);
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, quietly);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, quietly);
  return {
    open: (threadId: string) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: ThreadId.make(threadId) }),
      }),
    snooze: async (entry: NeedsYouEntry) =>
      failureOf(
        await snooze({
          environmentId,
          input: {
            threadId: ThreadId.make(entry.thread.threadId),
            snoozedUntil: tomorrowMorning(new Date()).toISOString(),
          },
        }),
      ),
    decide: async (entry: NeedsYouEntry, decision: ProviderApprovalDecision) => {
      if (entry.thread.requestId === null) return "这条审批已不在等待";
      return failureOf(
        await respondToApproval({
          environmentId,
          input: {
            threadId: ThreadId.make(entry.thread.threadId),
            requestId: entry.thread.requestId,
            decision,
          },
        }),
      );
    },
    /** A new message on the thread, which starts a new turn there. */
    send: async (entry: NeedsYouEntry, text: string) => {
      const threadId = ThreadId.make(entry.thread.threadId);
      const shell = appAtomRegistry.get(
        environmentThreadShells.threadShellAtom({ environmentId, threadId }),
      );
      if (shell === null) return "线程已不可用";
      return failureOf(
        await startTurn({
          environmentId,
          input: {
            threadId,
            message: { messageId: newMessageId(), role: "user", text, attachments: [] },
            runtimeMode: shell.runtimeMode,
            interactionMode: DEFAULT_INTERACTION_MODE,
          },
        }),
      );
    },
  };
}
