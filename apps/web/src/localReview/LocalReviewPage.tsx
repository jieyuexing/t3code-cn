import type {
  EnvironmentId,
  LocalReviewCommit,
  LocalReviewLogResult,
  ReviewDiffFileStat,
} from "@t3tools/contracts";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { Button } from "../components/ui/button";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { LocalReviewFileDiff } from "./LocalReviewDiff";
import { LocalReviewSourceSwitch } from "./LocalReviewSourceSwitch";
import {
  ALL_REPOS,
  PAGE_SIZE,
  commitBody,
  filesFromPatch,
  fileStatusLabel,
  isMerge,
  listSelections,
  relativeLabel,
  repoLabel,
  selectionKey,
  shortHash,
  type Selection,
} from "./localReview.logic";
import { localReviewEnvironment } from "./localReviewState";

type Repos = LocalReviewLogResult["repos"];

function RelativeTime({ iso }: { iso: string }) {
  const label = relativeLabel(useRelativeTimeState(iso));
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{label}</TooltipTrigger>
      <TooltipPopup side="top">{new Date(iso).toLocaleString()}</TooltipPopup>
    </Tooltip>
  );
}

function RowButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
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
      {children}
    </button>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-32 truncate rounded-sm bg-muted px-1.5 py-px text-2xs text-muted-foreground">
      {children}
    </span>
  );
}

function CommitRow({
  commit,
  repoName,
  selected,
  onSelect,
}: {
  commit: LocalReviewCommit;
  repoName: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <RowButton selected={selected} onSelect={onSelect}>
      <span className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{commit.subject}</span>
        {isMerge(commit) ? <Tag>合并</Tag> : null}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {repoName === null ? null : <span className="font-medium">{repoName}</span>}
        <span className="font-mono">{shortHash(commit.hash)}</span>
        <RelativeTime iso={commit.committedAt} />
        <span className="truncate">{commit.author}</span>
        {commit.refs.slice(0, 3).map((ref) => (
          <Tag key={ref}>{ref}</Tag>
        ))}
      </span>
    </RowButton>
  );
}

function FileRow({
  environmentId,
  selection,
  file,
}: {
  environmentId: EnvironmentId;
  selection: Selection;
  file: ReviewDiffFileStat;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 text-muted-foreground">{fileStatusLabel(file)}</span>
        <span className="min-w-0 flex-1 font-mono">
          <MiddleTruncate
            value={file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`}
          />
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <span className="text-success-foreground">+{file.additions}</span>{" "}
          <span className="text-destructive-foreground">−{file.deletions}</span>
        </span>
      </button>
      {open ? (
        <LocalReviewFileDiff
          environmentId={environmentId}
          selection={selection}
          path={file.path}
          previousPath={file.previousPath}
        />
      ) : null}
    </li>
  );
}

function Detail({
  environmentId,
  selection,
  commit,
  repoName,
}: {
  environmentId: EnvironmentId;
  selection: Selection;
  commit: LocalReviewCommit | undefined;
  repoName: string;
}) {
  const query = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: {
        cwd: selection.repo,
        metadataOnly: true,
        ...(selection.kind === "commit"
          ? { commitSha: selection.hash }
          : { sourceKind: "working-tree" as const }),
      },
    }),
  );
  const source = query.data?.sources[0];
  const partial = query.data !== null && source?.files === undefined;
  const files =
    query.data === null ? undefined : (source?.files ?? filesFromPatch(source?.diff ?? ""));
  const body = commit === undefined ? "" : commitBody(commit);
  return (
    <div className="flex flex-col gap-3">
      {commit === undefined ? (
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">未提交改动 · {repoName}</h2>
          <p className="text-xs text-muted-foreground">工作区相对 HEAD，含未跟踪文件。</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <h2 className="text-sm font-medium">{commit.subject}</h2>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>仓</dt>
            <dd className="m-0">{repoName}</dd>
            <dt>提交</dt>
            <dd className="m-0 font-mono">{commit.hash}</dd>
            <dt>作者</dt>
            <dd className="m-0">{commit.author}</dd>
            <dt>时间</dt>
            <dd className="m-0">{new Date(commit.committedAt).toLocaleString()}</dd>
            <dt>父提交</dt>
            <dd className="m-0 font-mono">
              {commit.parents.length === 0
                ? "无（首个提交）"
                : commit.parents.map((parent) => shortHash(parent)).join("  ")}
            </dd>
          </dl>
          {body === "" ? null : (
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm">{body}</pre>
          )}
        </div>
      )}
      <section className="flex flex-col gap-0.5">
        <h3 className="px-2 text-xs font-medium">
          {files === undefined ? "改动的文件" : `改动的文件 · ${files.length}`}
          {commit !== undefined && isMerge(commit) ? (
            <span className="font-normal text-muted-foreground"> · 与第一父提交比较</span>
          ) : null}
        </h3>
        {partial && source !== undefined ? (
          <p className="px-2 text-xs text-muted-foreground">
            未跟踪文件太多或太大，清单只含已跟踪文件的改动。
          </p>
        ) : null}
        {files === undefined ? (
          <p
            className={cn(
              "px-2 text-xs",
              query.error === null ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {query.error ?? "正在读取文件清单…"}
          </p>
        ) : files.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">没有文件改动。</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {files.map((file) => (
              <FileRow
                key={`${file.previousPath ?? ""}>${file.path}`}
                environmentId={environmentId}
                selection={selection}
                file={file}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function LocalReviewPage({ environmentId }: { environmentId: EnvironmentId | null }) {
  const [repo, setRepo] = useState(ALL_REPOS);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [kept, setKept] = useState<LocalReviewLogResult | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const scope = repo === ALL_REPOS ? {} : { repo };
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : localReviewEnvironment.log({
          environmentId,
          input: { part: "commits", limit, ...scope },
        }),
  );
  const log = query.data ?? kept;
  // Untracked scans are slow; start them once the first commits are on screen.
  const dirtyQuery = useEnvironmentQuery(
    environmentId === null || log === null
      ? null
      : localReviewEnvironment.log({ environmentId, input: { part: "dirty", ...scope } }),
  );
  const dirty = dirtyQuery.data?.dirty ?? [];
  const repos: Repos = log?.repos ?? [];
  const selections = log === null ? [] : listSelections(dirty, log.commits);
  const selection = selections.find((s) => selectionKey(s) === selectedKey) ?? selections[0];
  const commit =
    selection?.kind === "commit"
      ? log?.commits.find((c) => c.repo === selection.repo && c.hash === selection.hash)
      : undefined;
  const showRepoName = repo === ALL_REPOS;
  const changeRepo = (next: string) => {
    setRepo(next);
    setLimit(PAGE_SIZE);
    setKept(null);
    setSelectedKey(null);
  };
  const refresh = () => {
    query.refresh();
    dirtyQuery.refresh();
  };
  const loadMore = () => {
    setKept(log);
    setLimit(limit + PAGE_SIZE);
  };

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
            aria-label="提交"
            className="flex max-h-80 shrink-0 flex-col gap-0.5 overflow-y-auto border-b border-border/60 p-2 @2xl/local-review:max-h-none @2xl/local-review:w-96 @2xl/local-review:border-r @2xl/local-review:border-b-0"
          >
            <div className="flex items-center gap-1.5 pb-1">
              <Select value={repo} onValueChange={(next) => changeRepo(next ?? ALL_REPOS)}>
                <SelectTrigger size="sm" aria-label="选择仓">
                  <SelectValue>
                    {repo === ALL_REPOS ? "全部仓" : repoLabel(repos, repo)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_REPOS}>全部仓</SelectItem>
                  {repos.map((entry) => (
                    <SelectItem key={entry.path} value={entry.path}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button size="icon-xs" variant="ghost-muted" aria-label="刷新" onClick={refresh}>
                <RefreshCwIcon aria-hidden />
              </Button>
            </div>
            {query.error !== null && log === null ? (
              <p className="px-2.5 text-sm text-destructive">{query.error}</p>
            ) : log === null ? (
              <p className="px-2.5 text-sm text-muted-foreground">正在读取提交…</p>
            ) : selections.length === 0 ? (
              <p className="px-2.5 text-sm text-muted-foreground">
                {repos.length === 0 ? "没有发现 git 仓。" : "还没有提交。"}
              </p>
            ) : (
              <>
                {dirty.length > 1 ? (
                  <button
                    type="button"
                    aria-expanded={dirtyOpen}
                    onClick={() => setDirtyOpen(!dirtyOpen)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        "size-3 shrink-0 transition-transform",
                        dirtyOpen && "rotate-90",
                      )}
                    />
                    未提交改动 · {dirty.length} 个仓
                  </button>
                ) : null}
                {dirty.length > 1 && !dirtyOpen
                  ? null
                  : dirty.map((entry) => (
                      <RowButton
                        key={entry.repo}
                        selected={selection?.kind === "dirty" && selection.repo === entry.repo}
                        onSelect={() =>
                          setSelectedKey(selectionKey({ kind: "dirty", repo: entry.repo }))
                        }
                      >
                        <span className="truncate text-sm font-medium">
                          未提交改动 · {repoLabel(repos, entry.repo)} · {entry.changeCount} 项
                        </span>
                      </RowButton>
                    ))}
                {log.commits.map((entry) => (
                  <CommitRow
                    key={`${entry.repo}|${entry.hash}`}
                    commit={entry}
                    repoName={showRepoName ? repoLabel(repos, entry.repo) : null}
                    selected={
                      selection?.kind === "commit" &&
                      selection.repo === entry.repo &&
                      selection.hash === entry.hash
                    }
                    onSelect={() =>
                      setSelectedKey(
                        selectionKey({ kind: "commit", repo: entry.repo, hash: entry.hash }),
                      )
                    }
                  />
                ))}
                {log.hasMore ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={query.isPending}
                    onClick={loadMore}
                  >
                    {query.isPending ? "正在加载…" : "加载更多"}
                  </Button>
                ) : null}
              </>
            )}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
            {selection !== undefined && environmentId !== null ? (
              <DiffWorkerPoolProvider>
                <Detail
                  key={selectionKey(selection)}
                  environmentId={environmentId}
                  selection={selection}
                  commit={commit}
                  repoName={repoLabel(repos, selection.repo)}
                />
              </DiffWorkerPoolProvider>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
