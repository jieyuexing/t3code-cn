import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveThreadActivityTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import { useSyncExternalStore } from "react";

import { FAVORITE_THREAD_TAG, isThreadFavorited } from "../../hooks/useThreadFavorite.cn";
import { resolveSidebarRowStatus } from "../Sidebar.logic";

export { FAVORITE_THREAD_TAG, isThreadFavorited };
export const FAVORITES_SHELF_EXPANDED_STORAGE_KEY = "t3code-cn:sidebar:favorites-expanded:v1";

type FavoriteTagInput = {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?: { readonly tags?: ReadonlyArray<string> | undefined } | undefined;
};

type FavoriteStatusThread = Parameters<typeof resolveSidebarRowStatus>[0] &
  Parameters<typeof hasQueuedTurnStart>[0] & {
    readonly interactionMode: "default" | "plan";
    readonly hasActionableProposedPlan: boolean;
  };

export type FavoritePartitionThread = FavoriteTagInput &
  FavoriteStatusThread & {
    readonly archivedAt: string | null;
    readonly pinnedAt: string | null;
  };

export type FavoriteSortThread = Parameters<typeof resolveThreadActivityTimestamp>[0] & {
  readonly id: string;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem" | "removeItem">;

const shelfListeners = new Set<() => void>();

function isPlanRunSettled(thread: Pick<FavoriteStatusThread, "latestRun" | "runtime">): boolean {
  const { latestRun, runtime } = thread;
  if (latestRun === null) return false;
  if (
    latestRun.status === "preparing" ||
    latestRun.status === "queued" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
  ) {
    return false;
  }
  return runtime?.activeRunId !== latestRun.runId;
}

/**
 * Favorited threads return to normal Working/Active sections while running,
 * queued to start, awaiting user approval/input/plan review, or showing an unseen failure.
 */
function shouldFavoriteThreadUseNormalSection(
  thread: FavoriteStatusThread,
  options: {
    readonly workingShelfEnabled?: boolean;
    readonly isWorkingInInbox?: boolean;
    readonly now?: string;
  } = {},
): boolean {
  if (resolveSidebarRowStatus(thread) !== "ready") return true;
  if (options.workingShelfEnabled === true && options.isWorkingInInbox === true) return true;
  if (options.now !== undefined && hasQueuedTurnStart(thread, { now: options.now })) return true;
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isPlanRunSettled(thread)
  ) {
    return true;
  }
  return false;
}

export function resolveFavoriteThreadSection(
  thread: FavoritePartitionThread,
  options: {
    readonly workingShelfEnabled?: boolean;
    readonly isWorkingInInbox?: boolean;
    readonly now?: string;
  } = {},
): "pinned" | "favorites" | "normal" {
  if (thread.archivedAt != null) return "normal";
  if (thread.pinnedAt != null) return "pinned";
  if (!isThreadFavorited(thread)) return "normal";
  return shouldFavoriteThreadUseNormalSection(thread, options) ? "normal" : "favorites";
}

export function sortFavoriteThreads<T extends FavoriteSortThread>(threads: readonly T[]): T[] {
  return threads
    .map((thread) => {
      const timestamp = resolveThreadActivityTimestamp(thread);
      const parsed = timestamp === null ? null : toSortableTimestamp(timestamp);
      return { thread, timestampMs: parsed ?? 0 };
    })
    .toSorted(
      (left, right) =>
        right.timestampMs - left.timestampMs ||
        (left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0),
    )
    .map(({ thread }) => thread);
}

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readFavoritesShelfExpanded(storage?: StorageReader | null): boolean {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return false;
  try {
    return target.getItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeFavoritesShelfExpanded(
  expanded: boolean,
  storage?: StorageWriter | null,
): boolean {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return false;
  try {
    if (expanded) {
      target.setItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY, "true");
    } else {
      target.removeItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY);
    }
  } catch {
    return false;
  }
  if (storage === undefined) {
    for (const listener of shelfListeners) listener();
  }
  return true;
}

function subscribeFavoritesShelfExpanded(listener: () => void): () => void {
  shelfListeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      shelfListeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === FAVORITES_SHELF_EXPANDED_STORAGE_KEY || event.key === null) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    shelfListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFavoritesShelfExpanded(): readonly [boolean, () => void] {
  const expanded = useSyncExternalStore(
    subscribeFavoritesShelfExpanded,
    () => readFavoritesShelfExpanded(),
    () => false,
  );
  const toggle = () => {
    writeFavoritesShelfExpanded(!readFavoritesShelfExpanded());
  };
  return [expanded, toggle] as const;
}
