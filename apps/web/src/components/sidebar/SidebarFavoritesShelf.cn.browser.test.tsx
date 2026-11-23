import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { readLocalApi } from "../../localApi";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { makeThreadFixture } from "../../test-fixtures";
import type { Project } from "../../types";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";
import { FAVORITE_THREAD_TAG, FAVORITES_SHELF_EXPANDED_STORAGE_KEY } from "./favorites-cn";

vi.mock("../../state/entities", { spy: true });
vi.mock("../../hooks/useHandleNewThread", { spy: true });
vi.mock("../../hooks/useNowMinute", { spy: true });
vi.mock("../../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../state/use-orchestration-command", { spy: true });
vi.mock("../../localApi", { spy: true });
vi.mock("../sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function makeFavoriteThread(
  projectId: ProjectId,
  id: string,
  title: string,
  opts: {
    readonly favorited?: boolean;
    readonly pinnedAt?: string | null;
    readonly settledOverride?: "settled" | "active" | null;
    readonly running?: boolean;
    readonly latestUserMessageAt?: string | null;
  } = {},
) {
  const thread = makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(id),
    projectId,
    title,
    pinnedAt: opts.pinnedAt ?? null,
    settledOverride: opts.settledOverride ?? null,
    latestUserMessageAt: opts.latestUserMessageAt ?? "2026-01-01T00:00:00.000Z",
    ...(opts.running
      ? {
          runtime: {
            status: "running",
            activeRunId: RunId.make(`run-${id}`),
            providerInstanceId: "codex" as never,
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        }
      : {}),
  });
  if (!opts.favorited) return thread;
  return {
    ...thread,
    source: {
      ...thread.source,
      tags: [FAVORITE_THREAD_TAG],
    },
  };
}

function setupSidebarMocks(
  activeProject: Project,
  threads: ReturnType<typeof makeFavoriteThread>[],
  routeThreadId?: ThreadId,
) {
  const routeThreadRef = routeThreadId
    ? scopeThreadRef(activeProject.environmentId, routeThreadId)
    : null;
  vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(readEnvironmentSupportsAutoSettleOptOut).mockReturnValue(true);
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        activeProject.environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
          environment: { capabilities: { threadAutoSettleOptOut: true } },
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  vi.mocked(useThreadRouteTarget).mockReturnValue(
    routeThreadRef ? { kind: "server", threadRef: routeThreadRef } : null,
  );
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: {
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
    },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
}

describe("SidebarFavoritesShelf", () => {
  it.each([false, true])(
    "renders collapsible Favorites shelf in flat and boring sidebar (boring=%s)",
    async (boring) => {
      using stack = new DisposableStack();
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      stack.defer(() => window.localStorage.removeItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY));
      window.localStorage.removeItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY);
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        boringSidebarEnabled: boring,
      });

      const activeProject = project("alpha");
      const threads = [
        makeFavoriteThread(activeProject.id, "t-active", "Normal Active"),
        makeFavoriteThread(activeProject.id, "t-fav-idle", "Saved Context", {
          favorited: true,
          settledOverride: "settled",
          latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        }),
        makeFavoriteThread(activeProject.id, "t-fav-older", "Older Saved", {
          favorited: true,
          latestUserMessageAt: "2026-01-01T00:00:00.000Z",
        }),
        makeFavoriteThread(activeProject.id, "t-fav-pinned", "Pinned Favorite", {
          favorited: true,
          pinnedAt: "2026-01-01T00:00:00.000Z",
        }),
        makeFavoriteThread(activeProject.id, "t-fav-running", "Running Favorite", {
          favorited: true,
          running: true,
        }),
      ];
      setupSidebarMocks(activeProject, threads);

      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );

      const toggle = screen.getByTestId("sidebar-favorites-shelf-toggle");
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.element(toggle).toHaveTextContent("Favorites2");

      // Pinned and running favorited threads leave Favorites: pinned stays in Pinned,
      // running moves to Working (flat) or the project folder (boring).
      await expect.element(screen.getByText("Pinned Favorite").first()).toBeInTheDocument();
      if (boring) {
        await expect.element(screen.getByText("Running Favorite").first()).toBeInTheDocument();
      } else {
        await expect
          .element(screen.getByTestId("sidebar-working-shelf-toggle"))
          .toHaveTextContent("Working1");
      }
      await expect.element(screen.getByText("Saved Context")).not.toBeInTheDocument();

      await userEvent.click(toggle);
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      expect(window.localStorage.getItem(FAVORITES_SHELF_EXPANDED_STORAGE_KEY)).toBe("true");
      await expect.element(screen.getByText("Saved Context").first()).toBeInTheDocument();
      await expect.element(screen.getByText("Older Saved").first()).toBeInTheDocument();
    },
  );

  it.each([
    {
      favoritedBefore: false,
      expectedAction: "favorite",
      expectedTagged: true,
      expectedAutoSettle: false,
    },
    {
      favoritedBefore: true,
      expectedAction: "unfavorite",
      expectedTagged: false,
      expectedAutoSettle: true,
    },
  ])(
    "dispatches thread.tag.set and thread.auto-settle.set for $expectedAction from the menu",
    async ({ favoritedBefore, expectedAction, expectedTagged, expectedAutoSettle }) => {
      using stack = new DisposableStack();
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

      const activeProject = project("alpha");
      const target = makeFavoriteThread(activeProject.id, "t-1", "Thread One", {
        favorited: favoritedBefore,
      });
      setupSidebarMocks(activeProject, [target], target.id);

      const setTagMock = vi.fn().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
      const setAutoSettleMock = vi
        .fn()
        .mockResolvedValue({ _tag: "Success", value: { sequence: 2 } });
      vi.mocked(useOrchestrationCommand).mockImplementation((command) => {
        if (command === threadEnvironment.setTag) return setTagMock as never;
        if (command === threadEnvironment.setAutoSettle) return setAutoSettleMock as never;
        return vi.fn().mockResolvedValue({ _tag: "Success" }) as never;
      });

      const show = vi.fn().mockResolvedValue(expectedAction);
      vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);

      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );

      const row = screen.getByText("Thread One").first();
      await userEvent.click(row, { button: "right" });
      await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      expect(
        show.mock.calls[0]?.[0].some((item: { id: string }) => item.id === expectedAction),
      ).toBe(true);
      await vi.waitFor(() => expect(setTagMock).toHaveBeenCalledTimes(1));
      expect(setTagMock).toHaveBeenCalledWith({
        environmentId: activeProject.environmentId,
        input: { threadId: target.id, tag: FAVORITE_THREAD_TAG, tagged: expectedTagged },
      });
      await vi.waitFor(() => expect(setAutoSettleMock).toHaveBeenCalledTimes(1));
      expect(setAutoSettleMock).toHaveBeenCalledWith({
        environmentId: activeProject.environmentId,
        input: { threadId: target.id, enabled: expectedAutoSettle },
      });
    },
  );
});
