import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import {
  FAVORITE_THREAD_TAG,
  FAVORITES_SHELF_EXPANDED_STORAGE_KEY,
  isThreadFavorited,
  readFavoritesShelfExpanded,
  resolveFavoriteThreadSection,
  sortFavoriteThreads,
  writeFavoritesShelfExpanded,
} from "./favorites-cn";

function makeFavoriteTestThread(
  overrides: ThreadFixtureOverrides & { readonly tags?: ReadonlyArray<string> } = {},
) {
  const { tags, ...rest } = overrides;
  const thread = makeThreadFixture(rest);
  if (tags === undefined) return thread;
  return {
    ...thread,
    source: {
      ...thread.source,
      tags: [...tags],
    },
  };
}

describe("favorites-cn", () => {
  it("detects the favorite tag from thread.source.tags or tags", () => {
    expect(isThreadFavorited(makeFavoriteTestThread())).toBe(false);
    expect(isThreadFavorited(makeFavoriteTestThread({ tags: ["other"] }))).toBe(false);
    expect(
      isThreadFavorited(makeFavoriteTestThread({ tags: ["other", FAVORITE_THREAD_TAG] })),
    ).toBe(true);
    expect(isThreadFavorited({ tags: [FAVORITE_THREAD_TAG] })).toBe(true);
  });

  describe("resolveFavoriteThreadSection", () => {
    const now = "2026-01-01T00:00:30.000Z";

    it("keeps non-favorited and archived threads on the normal upstream path", () => {
      expect(resolveFavoriteThreadSection(makeFavoriteTestThread(), { now })).toBe("normal");
      expect(
        resolveFavoriteThreadSection(
          makeFavoriteTestThread({
            tags: [FAVORITE_THREAD_TAG],
            archivedAt: "2026-01-01T00:00:00.000Z",
          }),
          { now },
        ),
      ).toBe("normal");
    });

    it("prioritizes pinned over favorites", () => {
      const thread = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        pinnedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(resolveFavoriteThreadSection(thread, { now })).toBe("pinned");
    });

    it("places idle favorited threads in favorites even if settled or snoozed", () => {
      const settledFavorite = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      });
      const snoozedFavorite = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        snoozedAt: "2026-01-01T00:00:00.000Z",
        snoozedUntil: "2026-01-02T00:00:00.000Z",
      });

      expect(resolveFavoriteThreadSection(settledFavorite, { now })).toBe("favorites");
      expect(resolveFavoriteThreadSection(snoozedFavorite, { now })).toBe("favorites");
    });

    it.each([
      {
        name: "running runtime",
        overrides: {
          runtime: {
            status: "running" as const,
            activeRunId: RunId.make("run-1"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        name: "preparing runtime",
        overrides: {
          runtime: {
            status: "preparing" as const,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        name: "waiting on background work",
        overrides: {
          runtime: {
            status: "idle" as const,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      {
        name: "pending approval",
        overrides: { hasPendingApprovals: true },
      },
      {
        name: "pending user input",
        overrides: { hasPendingUserInput: true },
      },
      {
        name: "pending subagent request",
        overrides: { pendingSubagentRequest: "approval" as const },
      },
      {
        name: "pending guest message",
        overrides: { pendingGuestMessageCount: 1 },
      },
      {
        name: "unseen failed run",
        overrides: {
          lastVisitedAt: "2026-01-01T00:00:00.000Z",
          latestRun: {
            runId: RunId.make("run-fail"),
            status: "failed" as const,
            requestedAt: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:02:00.000Z",
            assistantMessageId: null,
          },
          runtime: {
            status: "failed" as const,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: "boom",
            updatedAt: "2026-01-01T00:02:00.000Z",
          },
        },
      },
      {
        name: "usage limit error",
        overrides: {
          runtime: {
            status: "failed" as const,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: "limit",
            lastErrorClass: "usage_limit" as const,
            updatedAt: "2026-01-01T00:02:00.000Z",
          },
        },
      },
      {
        name: "actionable proposed plan",
        overrides: {
          interactionMode: "plan" as const,
          hasActionableProposedPlan: true,
          latestRun: {
            runId: RunId.make("run-plan"),
            status: "completed" as const,
            requestedAt: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:02:00.000Z",
            assistantMessageId: null,
          },
        },
      },
    ])("returns $name favorited threads to normal sections", ({ overrides }) => {
      const thread = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        ...overrides,
      });
      expect(resolveFavoriteThreadSection(thread, { now })).toBe("normal");
    });

    it("returns favorited thread to favorites once a failure has been visited", () => {
      const thread = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        lastVisitedAt: "2026-01-01T00:03:00.000Z",
        latestRun: {
          runId: RunId.make("run-fail"),
          status: "failed",
          requestedAt: "2026-01-01T00:01:00.000Z",
          startedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:02:00.000Z",
          assistantMessageId: null,
        },
        runtime: {
          status: "failed",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: "boom",
          updatedAt: "2026-01-01T00:02:00.000Z",
        },
      });
      expect(resolveFavoriteThreadSection(thread, { now })).toBe("favorites");
    });

    it("honors inbox working grace and queued turn starts", () => {
      const idle = makeFavoriteTestThread({ tags: [FAVORITE_THREAD_TAG] });
      expect(
        resolveFavoriteThreadSection(idle, {
          now,
          workingShelfEnabled: true,
          isWorkingInInbox: true,
        }),
      ).toBe("normal");

      const queued = makeFavoriteTestThread({
        tags: [FAVORITE_THREAD_TAG],
        latestUserMessageAt: "2026-01-01T00:00:20.000Z",
      });
      expect(resolveFavoriteThreadSection(queued, { now })).toBe("normal");
    });
  });

  describe("sortFavoriteThreads", () => {
    it("sorts by latest activity descending with id ascending tie-breaker", () => {
      const t1 = makeFavoriteTestThread({
        id: ThreadId.make("b-oldest"),
        projectId: ProjectId.make("p"),
        environmentId: EnvironmentId.make("e"),
        latestUserMessageAt: "2026-01-01T00:00:00.000Z",
      });
      const t2 = makeFavoriteTestThread({
        id: ThreadId.make("a-tie"),
        projectId: ProjectId.make("p"),
        environmentId: EnvironmentId.make("e"),
        latestRun: {
          runId: RunId.make("r2"),
          status: "completed",
          requestedAt: "2026-01-02T00:00:00.000Z",
          startedAt: "2026-01-02T00:00:00.000Z",
          completedAt: "2026-01-03T00:00:00.000Z",
          assistantMessageId: null,
        },
      });
      const t3 = makeFavoriteTestThread({
        id: ThreadId.make("c-tie"),
        projectId: ProjectId.make("p"),
        environmentId: EnvironmentId.make("e"),
        latestUserMessageAt: "2026-01-03T00:00:00.000Z",
      });
      const t4 = makeFavoriteTestThread({
        id: ThreadId.make("d-newest"),
        projectId: ProjectId.make("p"),
        environmentId: EnvironmentId.make("e"),
        latestUserMessageAt: "2026-01-04T00:00:00.000Z",
      });

      const input = [t1, t3, t2, t4];
      const sorted = sortFavoriteThreads(input);
      expect(sorted.map((thread) => thread.id)).toEqual(["d-newest", "a-tie", "c-tie", "b-oldest"]);
      expect(input.map((thread) => thread.id)).toEqual(["b-oldest", "c-tie", "a-tie", "d-newest"]);
    });
  });

  describe("localStorage shelf expansion state", () => {
    it("defaults to false and reads/writes safely with try/catch", () => {
      const store = new Map<string, string>();
      const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => {
          store.set(key, value);
        },
        removeItem: (key) => {
          store.delete(key);
        },
      };

      expect(readFavoritesShelfExpanded(null)).toBe(false);
      expect(readFavoritesShelfExpanded(storage)).toBe(false);

      expect(writeFavoritesShelfExpanded(true, storage)).toBe(true);
      expect(store.get(FAVORITES_SHELF_EXPANDED_STORAGE_KEY)).toBe("true");
      expect(readFavoritesShelfExpanded(storage)).toBe(true);

      expect(writeFavoritesShelfExpanded(false, storage)).toBe(true);
      expect(store.has(FAVORITES_SHELF_EXPANDED_STORAGE_KEY)).toBe(false);
      expect(readFavoritesShelfExpanded(storage)).toBe(false);

      store.set(FAVORITES_SHELF_EXPANDED_STORAGE_KEY, "unexpected");
      expect(readFavoritesShelfExpanded(storage)).toBe(false);

      const brokenStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      };
      expect(readFavoritesShelfExpanded(brokenStorage)).toBe(false);
      expect(writeFavoritesShelfExpanded(true, brokenStorage)).toBe(false);
      expect(writeFavoritesShelfExpanded(false, brokenStorage)).toBe(false);
    });
  });
});
