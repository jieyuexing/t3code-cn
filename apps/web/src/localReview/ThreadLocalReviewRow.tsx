import { useNavigate } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ListTreeIcon } from "lucide-react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../components/chat/threadDetailsPanelStyles";

export function ThreadLocalReviewRow({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  return (
    <ThreadDetailsControl
      variant="ghost"
      size="sm"
      part="row"
      onClick={() =>
        void navigate({
          to: "/pull-requests",
          search: {
            source: "local",
            localThread: threadRef.threadId,
            environmentId: threadRef.environmentId,
            involvement: "all",
            state: "open",
            q: undefined,
            author: undefined,
            labels: undefined,
          },
        })
      }
    >
      <ListTreeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">本线程的请求</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">打开本地 ↗</span>
    </ThreadDetailsControl>
  );
}
