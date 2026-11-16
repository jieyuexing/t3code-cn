import type {
  EnvironmentId,
  GitLogCommit,
  GitLogListResult,
  ReviewDiffFileStat,
} from "@t3tools/contracts";
import { Columns2Icon, RefreshCwIcon, Rows3Icon } from "lucide-react";
import { useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { MiddleTruncate } from "../components/ui/middle-truncate";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useDebouncedValue } from "../state/queries";
import { reviewEnvironment } from "../state/review";
import { GitLogFileDiff } from "./GitLogFileDiff";
import { GitLogGraphCell } from "./GitLogGraphCell";
import { GitLogSourceSwitch } from "./GitLogSourceSwitch";
import { drawGraph, graphColumn, startGraph } from "./graph";
import {
  FILTER_DELAY_MS,
  PAGE_SIZE,
  fullTime,
  isMerge,
  shortTime,
  splitPath,
  statusLetter,
} from "./gitLog.logic";
import { gitLogEnvironment } from "./gitLogState";

const LOAD_MORE_DISTANCE_PX = 80;

function CommitRow({
  commit,
  graph,
  selected,
  onSelect,
}: {
  commit: GitLogCommit;
  graph: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={cn(
        "flex h-[22px] cursor-default items-center gap-2 px-2.5 text-sm",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {graph}
      <span className="w-[5.5rem] shrink-0 font-mono text-xs text-muted-foreground">
        {shortTime(commit.committedAt)}
      </span>
      <span className="w-20 shrink-0 truncate text-muted-foreground">{commit.author}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {commit.refs.slice(0, 3).map((ref) => (
          <span
            key={ref}
            className="max-w-32 shrink-0 truncate rounded-sm bg-muted px-1.5 text-2xs leading-4 text-muted-foreground"
          >
            {ref}
          </span>
        ))}
        <span className={cn("min-w-0 truncate", isMerge(commit) && "text-muted-foreground")}>
          {commit.subject}
        </span>
      </span>
    </div>
  );
}

function DiffLayoutToggle() {
  const diffLayout = useClientSettings((settings) => settings.diffLayout);
  return (
    <ToggleGroup
      aria-label="差异布局"
      variant="segmented"
      value={[diffLayout]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "stacked" || next === "split") updateClientSettings({ diffLayout: next });
      }}
    >
      <Toggle aria-label="统一" value="stacked">
        <Rows3Icon className="size-3.5" />
      </Toggle>
      <Toggle aria-label="并排" value="split">
        <Columns2Icon className="size-3.5" />
      </Toggle>
    </ToggleGroup>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: ReviewDiffFileStat;
  selected: boolean;
  onSelect: () => void;
}) {
  const [name, directory] = splitPath(file.path);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="w-3 shrink-0 font-mono font-medium">{statusLetter(file)}</span>
      <span className="min-w-0 flex-1 truncate">
        {file.previousPath === null ? (
          <>
            <span className="font-mono">{name}</span>
            {directory === "" ? null : (
              <span className="ml-2 text-muted-foreground">
                <MiddleTruncate value={directory} />
              </span>
            )}
          </>
        ) : (
          <span className="font-mono">{`${file.previousPath} → ${file.path}`}</span>
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        <span className="text-success-foreground">+{file.additions}</span>{" "}
        <span className="text-destructive-foreground">−{file.deletions}</span>
      </span>
    </button>
  );
}

function CommitDetail({
  environmentId,
  repo,
  commit,
}: {
  environmentId: EnvironmentId;
  repo: string;
  commit: GitLogCommit;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: { cwd: repo, commitSha: commit.hash, metadataOnly: true },
    }),
  );
  const files = query.data?.sources[0]?.files;
  const selected = files?.find((file) => file.path === selectedPath);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="truncate px-2 text-xs text-muted-foreground">
        {commit.author} · {fullTime(commit.committedAt)} · {commit.subject}
      </p>
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
        <div role="listbox" aria-label="提交的文件" className="flex flex-col">
          {files.map((file) => (
            <FileRow
              key={`${file.previousPath ?? ""}>${file.path}`}
              file={file}
              selected={selected === file}
              onSelect={() => setSelectedPath(selected === file ? null : file.path)}
            />
          ))}
        </div>
      )}
      {selected === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 px-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected.path}</span>
            {isMerge(commit) ? (
              <span className="shrink-0 text-xs text-muted-foreground">与第一父提交比较</span>
            ) : null}
            <DiffLayoutToggle />
          </div>
          <GitLogFileDiff
            key={selected.path}
            environmentId={environmentId}
            repo={repo}
            hash={commit.hash}
            path={selected.path}
            previousPath={selected.previousPath}
          />
        </div>
      )}
    </div>
  );
}

export function GitLogPage({ environmentId }: { environmentId: EnvironmentId | null }) {
  const [repo, setRepo] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [kept, setKept] = useState<GitLogListResult | null>(null);
  const [queryText, setQueryText] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const query = useDebouncedValue(queryText.trim(), FILTER_DELAY_MS);
  const result = useEnvironmentQuery(
    environmentId === null
      ? null
      : gitLogEnvironment.list({
          environmentId,
          input: { limit, ...(repo === null ? {} : { repo }), ...(query === "" ? {} : { query }) },
        }),
  );
  const log = result.data ?? kept;
  const commits = log?.commits ?? [];
  const activeRepo = log?.repo ?? "";
  const commit = commits.find((c) => c.hash === selectedHash) ?? commits[0];
  // Filtered or single-file history is not contiguous, so its lines would mean nothing.
  const graph =
    query === "" && commits.length > 0
      ? drawGraph(
          startGraph(),
          commits.map((c) => ({ id: c.hash, parents: [...c.parents] })),
        )
      : null;
  const column = graph === null ? null : graphColumn(graph.state.maxLanes);

  const changeRepo = (next: string) => {
    setRepo(next);
    setLimit(PAGE_SIZE);
    setKept(null);
    setSelectedHash(null);
  };
  const loadMore = () => {
    if (log === null || !log.hasMore || result.isPending) return;
    setKept(log);
    setLimit(limit + PAGE_SIZE);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Git 日志">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Git 日志</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <GitLogSourceSwitch active="git" />
        </WorkspacePageHeader>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 p-2">
          <Select value={activeRepo} onValueChange={(next) => changeRepo(next ?? activeRepo)}>
            <SelectTrigger size="sm" aria-label="选择仓" className="w-56 min-w-0 shrink-0">
              <SelectValue>
                {log?.repos.find((entry) => entry.path === activeRepo)?.name ?? ""}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(log?.repos ?? []).map((entry) => (
                <SelectItem key={entry.path} value={entry.path}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Input
            size="sm"
            aria-label="筛选"
            placeholder="筛选说明、作者、路径…"
            value={queryText}
            onChange={(event) => {
              setKept(log);
              setLimit(PAGE_SIZE);
              setQueryText(event.target.value);
            }}
          />
          <Button size="icon-xs" variant="ghost-muted" aria-label="刷新" onClick={result.refresh}>
            <RefreshCwIcon aria-hidden />
          </Button>
        </div>
        <div
          role="listbox"
          aria-label="提交"
          className="min-h-0 flex-[5] overflow-y-auto border-b border-border/60"
          onScroll={(event) => {
            const list = event.currentTarget;
            if (list.scrollHeight - list.scrollTop - list.clientHeight < LOAD_MORE_DISTANCE_PX) {
              loadMore();
            }
          }}
        >
          {result.error !== null && log === null ? (
            <p className="px-2.5 py-2 text-sm text-destructive">{result.error}</p>
          ) : log === null ? (
            <p className="px-2.5 py-2 text-sm text-muted-foreground">正在读取提交…</p>
          ) : commits.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-muted-foreground">
              {log.repos.length === 0 ? "没有发现 git 仓。" : "没有提交。"}
            </p>
          ) : (
            <>
              {commits.map((entry, index) => (
                <CommitRow
                  key={entry.hash}
                  commit={entry}
                  graph={
                    graph === null || column === null || graph.rows[index] === undefined ? null : (
                      <div style={{ width: column.width }} className="shrink-0">
                        <GitLogGraphCell row={graph.rows[index]} width={column.width} />
                      </div>
                    )
                  }
                  selected={entry.hash === commit?.hash}
                  onSelect={() => setSelectedHash(entry.hash)}
                />
              ))}
              {log.hasMore ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="w-full"
                  disabled={result.isPending}
                  onClick={loadMore}
                >
                  {result.isPending ? "正在加载…" : "加载更早…"}
                </Button>
              ) : null}
            </>
          )}
        </div>
        <div className="min-h-0 flex-[6] overflow-y-auto p-2">
          {commit !== undefined && environmentId !== null ? (
            <DiffWorkerPoolProvider>
              <CommitDetail
                key={`${activeRepo}|${commit.hash}`}
                environmentId={environmentId}
                repo={activeRepo}
                commit={commit}
              />
            </DiffWorkerPoolProvider>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}
