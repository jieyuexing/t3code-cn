/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy, outside upstream catalogs */
import type { EnvironmentId, NeedsYouDueItem, NeedsYouGtd } from "@t3tools/contracts";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useFileContextMenu } from "~/fileContextMenu";
import { toastManager } from "~/components/ui/toast";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import {
  GTD_DUE_DAYS,
  GTD_RECENT_DAYS,
  formatDaysLeft,
  orphanStats,
  threadIdOfSource,
  wakeGroups,
} from "./needsYouGtd.logic";

export type GtdTab = "pending" | "wake" | "inbox";

/** Copies a path relative to the project, and opens it where the server can open files. */
function useFileActions(environmentId: EnvironmentId, workspaceRoot: string) {
  const menu = useFileContextMenu(environmentId);
  return {
    canOpen: menu.capabilities.canOpenDefault,
    open: (filePath: string) =>
      void menu.activate("open", { environmentId, filePath, workspaceRoot }),
    copy: (filePath: string) =>
      void writeTextToClipboard(filePath).then(
        (copied) => {
          if (copied)
            toastManager.add({ type: "success", title: "已复制路径", description: filePath });
        },
        () => toastManager.add({ type: "error", title: "无法复制路径", description: filePath }),
      ),
  };
}
type FileActions = ReturnType<typeof useFileActions>;

function FileButtons(props: { readonly file: string; readonly actions: FileActions }) {
  return (
    <>
      <Button size="xs" variant="ghost-muted" onClick={() => props.actions.copy(props.file)}>
        复制路径
      </Button>
      {props.actions.canOpen ? (
        <Button size="xs" variant="ghost-muted" onClick={() => props.actions.open(props.file)}>
          打开
        </Button>
      ) : null}
    </>
  );
}

function DueRow(props: { readonly item: NeedsYouDueItem; readonly actions: FileActions }) {
  const { item } = props;
  return (
    <li className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <Badge variant={item.daysLeft < 0 ? "error" : item.daysLeft <= 3 ? "warning" : "info"}>
          {formatDaysLeft(item.daysLeft)}
        </Badge>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{item.date}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {item.section}
        </span>
      </div>
      <p className="line-clamp-2 text-sm">{item.excerpt}</p>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {item.file}:{item.line}
        </span>
        <FileButtons file={item.file} actions={props.actions} />
      </div>
    </li>
  );
}

function GroupTitle(props: { readonly children: string }) {
  return <h3 className="bg-muted/40 px-3 py-1 text-muted-foreground text-xs">{props.children}</h3>;
}

export function WakeTab(props: {
  readonly gtd: NeedsYouGtd;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const actions = useFileActions(props.environmentId, props.cwd);
  const { overdue, upcoming } = wakeGroups(props.gtd);
  if (overdue.length + upcoming.length === 0) {
    return <p className="px-3 py-4 text-muted-foreground text-sm">{GTD_DUE_DAYS} 天内没有到期项</p>;
  }
  return (
    <>
      {overdue.length > 0 ? (
        <>
          <GroupTitle>{`已逾期 · ${overdue.length}`}</GroupTitle>
          <ul>
            {overdue.map((item) => (
              <DueRow key={`${item.file}:${item.line}`} item={item} actions={actions} />
            ))}
          </ul>
        </>
      ) : null}
      {upcoming.length > 0 ? (
        <>
          <GroupTitle>{`${GTD_DUE_DAYS} 天内到期 · ${upcoming.length}`}</GroupTitle>
          <ul>
            {upcoming.map((item) => (
              <DueRow key={`${item.file}:${item.line}`} item={item} actions={actions} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

export function InboxTab(props: {
  readonly gtd: NeedsYouGtd;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly openThread: (threadId: string) => void;
}) {
  const actions = useFileActions(props.environmentId, props.cwd);
  const { topics, orphans } = props.gtd;
  return (
    <>
      <GroupTitle>{`话题收件 · ${topics.length}`}</GroupTitle>
      {topics.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-sm">收件箱是空的</p>
      ) : (
        <ul>
          {topics.map((topic) => {
            const threadId = threadIdOfSource(topic.thread);
            return (
              <li
                key={`${topic.capturedAt}:${topic.topic}`}
                className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
              >
                <p className="line-clamp-2 text-sm">{topic.topic}</p>
                <div className="flex items-center gap-2">
                  <Badge variant={topic.status === "started" ? "info" : "secondary"}>
                    {topic.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs tabular-nums">
                    {topic.capturedAt}
                  </span>
                  {threadId === null ? null : (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => props.openThread(threadId)}
                    >
                      打开线程
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <GroupTitle>{`近 ${GTD_RECENT_DAYS} 天零入链孤儿 · ${orphans.length}`}</GroupTitle>
      <p className="px-3 py-1.5 text-muted-foreground text-xs">{orphanStats(props.gtd)}</p>
      {orphans.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-sm">没有落盘孤儿</p>
      ) : (
        <ul>
          {orphans.map((orphan) => (
            <li
              key={`${orphan.date}:${orphan.repo}:${orphan.file}:${orphan.subject}`}
              className="flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {orphan.date}
                </span>
                <span className="shrink-0 text-xs">[{orphan.repo}]</span>
                <span className="min-w-0 flex-1 truncate text-sm">{orphan.subject}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
                  {orphan.file}
                </span>
                <FileButtons file={orphan.file} actions={actions} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
