import type {
  EnvironmentId,
  LocalReviewFile,
  LocalReviewGetResult,
  LocalReviewRequestHead,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "../components/RelativeTime";
import { Button } from "../components/ui/button";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { LocalReviewDiff } from "./LocalReviewDiff";
import { LocalReviewSourceSwitch } from "./LocalReviewSourceSwitch";
import {
  BLIND_SPOT_LABELS,
  EMPTY_LIST_TEXT,
  EMPTY_REQUEST_TEXT,
  LOCAL_REVIEW_DAYS,
  SCOPE_NOTES,
  describeFileState,
  describeSources,
  groupFilesByRepo,
  commitsOfRepo,
  shortHash,
} from "./localReview.logic";
import { localReviewEnvironment } from "./localReviewState";

function RequestRow({
  head,
  selected,
  onSelect,
}: {
  head: LocalReviewRequestHead;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="truncate text-sm font-medium">{head.threadTitle || "未命名线程"}</span>
      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <RelativeTime timestamp={head.startedAt} />
        {head.origin === "agent" ? <span>Agent 发起</span> : null}
        {head.runCount > 1 ? <span>{head.runCount} 轮</span> : null}
        {head.childCount > 0 ? <span>子会话 {head.childCount}</span> : null}
        <span>
          文件改动 {head.fileChangeCount} · 提交命令 {head.commitCommandCount}
        </span>
      </span>
    </button>
  );
}

function ScopeNotes({ detail }: { detail: LocalReviewGetResult }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">统计范围</summary>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
        {SCOPE_NOTES.map((note) => (
          <li key={note}>{note}</li>
        ))}
        {detail.blindSpots.map((spot) => (
          <li key={spot}>本请求：{BLIND_SPOT_LABELS[spot]}。</li>
        ))}
        {detail.clearedWorktrees > 0 ? (
          <li>已清理的临时工作树里改的 {detail.clearedWorktrees} 个文件没能对上提交。</li>
        ) : null}
        {detail.mentionedCommits > 0 ? (
          <li>另有 {detail.mentionedCommits} 个提交只是被命令输出提到，没有计入。</li>
        ) : null}
      </ul>
    </details>
  );
}

function FileRow({ file, onSelect }: { file: LocalReviewFile; onSelect: () => void }) {
  const state = describeFileState(file);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 font-mono">
          <MiddleTruncate value={file.path} />
        </span>
        <span className="shrink-0 text-muted-foreground">{describeSources(file)}</span>
        {state === null ? null : <span className="shrink-0 text-muted-foreground">{state}</span>}
      </button>
    </li>
  );
}

function RequestDetail({
  environmentId,
  head,
}: {
  environmentId: EnvironmentId;
  head: LocalReviewRequestHead;
}) {
  const query = useEnvironmentQuery(
    localReviewEnvironment.get({
      environmentId,
      input: { threadId: head.threadId, requestId: head.requestId },
    }),
  );
  const [selected, setSelected] = useState<{ repo: string; path: string } | null>(null);
  const detail = query.data;
  if (detail === null) {
    return (
      <p
        className={cn(
          "text-sm",
          query.error === null ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {query.error ?? "正在识别这一请求改了哪些文件…"}
      </p>
    );
  }
  const file =
    selected === null
      ? undefined
      : detail.files.find((f) => f.repo === selected.repo && f.path === selected.path);
  if (file !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost-muted" onClick={() => setSelected(null)}>
            <ArrowLeftIcon aria-hidden />
            返回清单
          </Button>
          <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
          <span className="shrink-0 text-xs text-muted-foreground">此文件本请求内的改动</span>
        </div>
        <LocalReviewDiff environmentId={environmentId} file={file} commits={detail.commits} />
      </div>
    );
  }
  const groups = groupFilesByRepo(detail.files);
  const total = detail.files.length + detail.omittedFiles;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">
          已识别 {total} 个文件
          <span className="font-normal text-muted-foreground">
            {" "}
            · 交付物 {detail.deliverables.length}
            {detail.complete ? "" : " · 可能不全"}
          </span>
        </h2>
        <ScopeNotes detail={detail} />
      </div>
      {detail.files.length === 0 && detail.deliverables.length === 0 ? (
        <p className="text-sm text-muted-foreground">{EMPTY_REQUEST_TEXT}</p>
      ) : null}
      {groups.map((group) => {
        const commits = commitsOfRepo(detail.commits, group.repo);
        return (
          <section key={group.repo} className="flex flex-col gap-0.5">
            <h3 className="flex items-baseline gap-2 px-2 text-xs font-medium">
              <span>{group.name}</span>
              <span className="min-w-0 truncate font-normal text-muted-foreground">
                {commits
                  .slice(0, 2)
                  .map((c) => `${shortHash(c.hash)} ${c.subject}`)
                  .join(" · ")}
                {commits.length > 2 ? ` 等 ${commits.length} 个提交` : ""}
              </span>
            </h3>
            <ul className="m-0 flex list-none flex-col p-0">
              {group.files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  onSelect={() => setSelected({ repo: f.repo, path: f.path })}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {detail.omittedFiles > 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          另 {detail.omittedFiles} 个文件未列出。
        </p>
      ) : null}
      {detail.deliverables.length > 0 ? (
        <section className="flex flex-col gap-0.5">
          <h3 className="px-2 text-xs font-medium">交付物（不进代码清单）</h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {detail.deliverables.map((path) => (
              <li key={path} className="px-2 py-0.5">
                <span className="block font-mono text-xs text-muted-foreground">
                  <MiddleTruncate value={path} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function LocalReviewPage({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | undefined;
}) {
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : localReviewEnvironment.list({
          environmentId,
          input: {
            days: LOCAL_REVIEW_DAYS,
            limit: 100,
            ...(threadId === undefined ? {} : { threadId }),
          },
        }),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requests = list.data?.requests ?? [];
  const selected = requests.find((r) => r.requestId === selectedId) ?? requests[0];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="@container/local-review flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="本地">
            <WorkspaceBreadcrumbItem>Pull requests</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">本地</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <LocalReviewSourceSwitch active="local" />
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col @2xl/local-review:flex-row">
          <nav
            aria-label="请求"
            className="flex max-h-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-b border-border/60 p-2 @2xl/local-review:max-h-none @2xl/local-review:w-80 @2xl/local-review:border-r @2xl/local-review:border-b-0"
          >
            <p className="px-2.5 pb-1 text-xs text-muted-foreground">
              近 {LOCAL_REVIEW_DAYS} 天 · 仅有改动{threadId === undefined ? "" : " · 当前线程"}
            </p>
            {list.error !== null ? (
              <p className="px-2.5 text-sm text-destructive">{list.error}</p>
            ) : list.data === null ? (
              <p className="px-2.5 text-sm text-muted-foreground">正在读取请求…</p>
            ) : requests.length === 0 ? (
              <p className="px-2.5 text-sm text-muted-foreground">{EMPTY_LIST_TEXT}</p>
            ) : (
              requests.map((head) => (
                <RequestRow
                  key={head.requestId}
                  head={head}
                  selected={head.requestId === selected?.requestId}
                  onSelect={() => setSelectedId(head.requestId)}
                />
              ))
            )}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            {selected !== undefined && environmentId !== null ? (
              <RequestDetail
                key={selected.requestId}
                environmentId={environmentId}
                head={selected}
              />
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
