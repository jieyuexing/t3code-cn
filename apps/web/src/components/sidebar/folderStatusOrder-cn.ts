import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

type FolderThread = Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0] & { readonly title: string };

// Same classification as the closed-folder dot, so order and dot never disagree.
function folderStatusTier(thread: FolderThread): number {
  switch (resolveSidebarThreadStatus(thread)) {
    case "input":
    case "approval":
    case "request":
    case "limited":
      return 0;
    case "failed":
      return 1;
    case "ready":
      return hasUnseenCompletion(thread) ? 2 : 3;
    case "waiting":
      return 4;
    default:
      return 5;
  }
}

const DATED_TITLE = /^(\d{2})(\d{2})_(.*)$/;
const UNDATED = -10000;

// `MMDD_<rest>` titles: newest day first, then the rest; a day after today is last year's.
function titleKey(title: string, today: number): { day: number; rest: string } {
  const match = DATED_TITLE.exec(title);
  if (!match) return { day: UNDATED, rest: "" };
  const day = Number(match[1]) * 100 + Number(match[2]);
  return { day: day > today ? day - 10000 : day, rest: match[3] ?? "" };
}

/**
 * Needs-you threads first, running threads last; within a tier `MMDD_` titles go newest day
 * first, then by the rest of the title. Undated titles and ties keep the incoming (send-time) order.
 */
export function sortFolderThreadsByStatus<T extends FolderThread>(
  threads: readonly T[],
  now: Date = new Date(),
): T[] {
  const today = (now.getMonth() + 1) * 100 + now.getDate();
  return threads
    .map((thread, index) => ({
      thread,
      index,
      tier: folderStatusTier(thread),
      ...titleKey(thread.title, today),
    }))
    .toSorted(
      (a, b) =>
        a.tier - b.tier ||
        b.day - a.day ||
        (a.rest < b.rest ? -1 : a.rest > b.rest ? 1 : 0) ||
        a.index - b.index,
    )
    .map(({ thread }) => thread);
}
