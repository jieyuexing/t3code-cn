import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { useThreadPreviewState } from "../../previewStateStore";
import { openBrowserTab } from "../browserTab";
import type { RailWebContext, WebAppItem } from "./rail.logic";

const NO_TABS: Readonly<Record<string, string>> = {};

interface WebAppTabsState {
  /** The tab each web app last opened, by thread and app id. Not saved: a reload finds tabs by their page. */
  readonly byThreadKey: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const useWebAppTabs = create<WebAppTabsState>()(() => ({ byThreadKey: {} }));

const rememberTab = (threadRef: ScopedThreadRef, appId: string, tabId: string) =>
  useWebAppTabs.setState(({ byThreadKey }) => {
    const key = scopedThreadKey(threadRef);
    return { byThreadKey: { ...byThreadKey, [key]: { ...byThreadKey[key], [appId]: tabId } } };
  });

/** Opens the web app as a tab of the thread's browser, in the profile it names, through the path `browser.open` uses. */
export async function openWebApp(
  threadRef: ScopedThreadRef,
  app: WebAppItem,
  openPreview: Parameters<typeof openBrowserTab>[0]["openPreview"],
) {
  const tabId = await openBrowserTab({
    threadRef,
    url: app.url,
    background: false,
    openPreview,
    ...(app.profileId === undefined ? {} : { profileId: app.profileId }),
  });
  if (tabId !== null) rememberTab(threadRef, app.id, tabId);
}

/** What lets the rail tell the thread's web app tabs from its other browser tabs. */
export function useRailWebContext(
  threadRef: ScopedThreadRef,
  webApps: ReadonlyArray<WebAppItem>,
): RailWebContext {
  const openedTabs = useWebAppTabs((state) => state.byThreadKey[scopedThreadKey(threadRef)]);
  const { sessions } = useThreadPreviewState(threadRef);
  return {
    webApps,
    openedTabs: openedTabs ?? NO_TABS,
    pageUrls: Object.fromEntries(
      Object.entries(sessions).flatMap(([tabId, session]) =>
        session.navStatus._tag === "Idle" ? [] : [[tabId, session.navStatus.url]],
      ),
    ),
  };
}
