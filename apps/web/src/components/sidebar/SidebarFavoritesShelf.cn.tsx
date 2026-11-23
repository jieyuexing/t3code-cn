import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { asLaunchingThread } from "@t3tools/client-runtime/state/thread-inbox";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SidebarThreadRow, type SidebarThreadRowProps } from "./SidebarThreadRow";

export function SidebarFavoritesHeader(props: {
  count: number;
  mtAuto: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const gt = useGT();
  return (
    <li
      data-testid="sidebar-favorites-header"
      className={cn("relative mx-0.5 h-8 list-none", props.mtAuto && "mt-auto")}
    >
      <CollapsibleSectionHeader
        data-sidebar-row="shelf:favorites"
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone="muted"
        data-testid="sidebar-favorites-shelf-toggle"
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {gt("Favorites", { $context: "sidebar section" })}
      </CollapsibleSectionHeader>
    </li>
  );
}

export function SidebarFavoriteRow(props: Omit<SidebarThreadRowProps, "sortable">) {
  const liveThread = useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id));
  const thread =
    liveThread === null
      ? props.thread
      : props.thread.runtime !== null
        ? asLaunchingThread(liveThread)
        : liveThread;
  return <SidebarThreadRow {...props} thread={thread} />;
}
