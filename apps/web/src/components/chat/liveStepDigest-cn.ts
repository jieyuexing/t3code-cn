import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";

import { m, type MessageResolver } from "../../i18n/messages";
import { workLogEntryIsToolLike, type WorkLogEntry } from "../../session-logic";

/**
 * The tool calls of the live row's current segment, such as "Read 3 files and ran 2 commands".
 * The timeline folds every call since the last assistant message into that one row, which names
 * only the latest; earlier segments already show their own summary. Null for a single call,
 * which the row already names.
 */
export function liveStepDigest(
  entries: ReadonlyArray<WorkLogEntry>,
  resolve: MessageResolver = m,
): string | null {
  const tools = entries.filter(
    (entry) => entry.itemType !== "reasoning" && workLogEntryIsToolLike(entry),
  );
  return tools.length < 2 ? null : summarizeToolGroup(tools, resolve).summary;
}
