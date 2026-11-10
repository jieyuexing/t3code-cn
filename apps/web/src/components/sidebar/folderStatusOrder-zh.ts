import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

type FolderThread = Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0];

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

/** Needs-you threads first, running threads last; ties keep the incoming (send-time) order. */
export function sortFolderThreadsByStatus<T extends FolderThread>(threads: readonly T[]): T[] {
  return threads
    .map((thread, index) => ({ thread, index, tier: folderStatusTier(thread) }))
    .toSorted((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ thread }) => thread);
}
