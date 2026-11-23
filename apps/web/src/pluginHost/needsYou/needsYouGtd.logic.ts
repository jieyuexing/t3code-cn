import type { NeedsYouDueItem, NeedsYouGtd } from "@t3tools/contracts";

/** An item due within this many days counts as "soon" for the hint on an empty needs-you list. */
const SOON_DAYS = 3;
export const GTD_DUE_DAYS = 30;
export const GTD_RECENT_DAYS = 14;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The thread id an inbox entry's `thread` text names, or null for plain text and `mcp:launch:` links. It is
 * the last id in the text, because `t3-thread://v2/<environment id>/<thread id>` leads with the environment's.
 */
export function threadIdOfSource(thread: string): string | null {
  return thread.match(UUID)?.at(-1)?.toLowerCase() ?? null;
}

const byDate = (a: NeedsYouDueItem, b: NeedsYouDueItem) =>
  a.date.localeCompare(b.date) || a.file.localeCompare(b.file) || a.line - b.line;

/** Overdue items longest overdue first, then upcoming items soonest first. */
export function wakeGroups(gtd: NeedsYouGtd) {
  return { overdue: gtd.overdue.toSorted(byDate), upcoming: gtd.upcoming.toSorted(byDate) };
}

export function formatDaysLeft(daysLeft: number): string {
  if (daysLeft < 0) return `逾期 ${-daysLeft} 天`;
  if (daysLeft === 0) return "今天";
  if (daysLeft === 1) return "明天";
  return `${daysLeft} 天后`;
}

/** Counts for the tab labels and the hint bar. */
export function gtdSummary(gtd: NeedsYouGtd) {
  return {
    wake: gtd.overdue.length + gtd.upcoming.length,
    soon: gtd.overdue.length + gtd.upcoming.filter((item) => item.daysLeft <= SOON_DAYS).length,
    inbox: gtd.topics.length + gtd.orphans.length,
  };
}

export const orphanStats = (gtd: NeedsYouGtd) =>
  `扫 ${gtd.reposScanned} 仓 · 已挂入口 ${gtd.recentLinkedCount} · 隐私省略 ${gtd.privateCount}`;
