/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { PendingThreadStatus } from "../pluginHost/pendingThreads";
import { cn } from "../lib/utils";
import {
  BERTH_COUNT,
  PRIMARY_BERTH_COUNT,
  enterBerth,
  leaveBerth,
  reconcileBerths,
  type BerthThread,
  type BerthView,
  type Berths,
} from "./berths.logic";
import { readBerths, writeBerths } from "./berthsStorage";

const STATUS_LABEL: Readonly<Record<PendingThreadStatus, string>> = {
  approval: "待审批",
  input: "待回答",
  request: "待处理",
  failed: "失败",
  working: "运行中",
  waiting: "等待中",
  done: "已完成",
};

const STATUS_VARIANT: Readonly<
  Record<PendingThreadStatus, "error" | "warning" | "info" | "secondary" | "success">
> = {
  approval: "error",
  input: "warning",
  request: "warning",
  failed: "error",
  working: "info",
  waiting: "secondary",
  done: "success",
};

const SLOTS = [0, 1, 2, 3, 4, 5] as const;

const NEEDS_YOU = new Set<PendingThreadStatus>(["approval", "input", "request", "failed"]);

function StatusBadge({ status }: { status: PendingThreadStatus }) {
  return (
    <Badge size="sm" variant={STATUS_VARIANT[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function OpenButton({
  thread,
  onOpen,
  className,
}: {
  thread: BerthThread;
  onOpen: (threadId: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn("min-w-0 truncate text-left outline-none hover:underline", className)}
      onClick={() => onOpen(thread.threadId)}
    >
      {thread.title}
    </button>
  );
}

function Berth({
  slot,
  thread,
  subagents,
  waiting,
  onOpen,
  onLeave,
  onEnter,
  offBerth,
}: {
  slot: number;
  thread: BerthThread | null;
  subagents: ReadonlyArray<BerthThread>;
  waiting: boolean;
  onOpen: (threadId: string) => void;
  onLeave: () => void;
  onEnter: (threadId: string) => void;
  offBerth: ReadonlyArray<BerthThread>;
}) {
  const tag = `泊位 ${slot + 1}`;
  const role = slot < PRIMARY_BERTH_COUNT ? "主力" : "副位";
  if (thread === null) {
    return (
      <section
        aria-label={tag}
        data-berth={slot + 1}
        data-empty
        className="flex h-60 flex-col gap-2 rounded-lg border border-dashed border-border p-3"
      >
        <p className="text-sm text-muted-foreground">
          {tag} · {waiting ? "读取中" : "空闲"} · {role}
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {offBerth.map((candidate) => (
            <Button
              key={candidate.threadId}
              size="xs"
              variant="ghost-muted"
              className="w-full justify-start"
              onClick={() => onEnter(candidate.threadId)}
            >
              <span className="truncate">放入：{candidate.title}</span>
            </Button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section
      aria-label={tag}
      data-berth={slot + 1}
      className="flex h-60 flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          {tag} · {role}
        </span>
        <div className="min-w-0 flex-1" />
        <Button size="xs" variant="ghost-muted" onClick={onLeave}>
          移出
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm font-medium">
        <OpenButton thread={thread} onOpen={onOpen} className="flex-1" />
        <StatusBadge status={thread.status} />
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {thread.model}
        {thread.branch === null ? "" : ` · ${thread.branch}`}
      </p>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto border-t border-border/60 pt-2">
        {subagents.map((child) => (
          <li key={child.threadId} className="flex items-center gap-2 text-xs">
            <OpenButton thread={child} onOpen={onOpen} className="flex-1" />
            <span className="shrink-0 text-muted-foreground">{child.model}</span>
            <StatusBadge status={child.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OffBerthRow({
  thread,
  subagentCount,
  hasEmpty,
  picking,
  onOpen,
  onEnter,
  onPick,
}: {
  thread: BerthThread;
  subagentCount: number;
  hasEmpty: boolean;
  picking: boolean;
  onOpen: (threadId: string) => void;
  onEnter: (threadId: string, slot?: number) => void;
  onPick: () => void;
}) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <OpenButton thread={thread} onOpen={onOpen} className="flex-1" />
        <StatusBadge status={thread.status} />
        <span className="shrink-0 text-xs text-muted-foreground">子代理 {subagentCount}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={hasEmpty ? () => onEnter(thread.threadId) : onPick}
        >
          入泊位
        </Button>
      </div>
      {picking ? (
        <div className="flex items-center gap-1 pl-1">
          {Array.from({ length: BERTH_COUNT }, (_, slot) => (
            <Button
              key={slot}
              size="xs"
              variant="ghost-muted"
              aria-label={`放入泊位 ${slot + 1}`}
              onClick={() => onEnter(thread.threadId, slot)}
            >
              {slot + 1}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function BerthsBoard({
  environmentId,
  view,
  ready,
  onOpen,
}: {
  environmentId: EnvironmentId;
  view: BerthView;
  ready: boolean;
  onOpen: (threadId: string) => void;
}) {
  const [stored, setStored] = useState(() => readBerths(environmentId));
  const [picking, setPicking] = useState<string | null>(null);
  const [scheduledOpen, setScheduledOpen] = useState(false);

  const known = new Map([...view.threads, ...view.scheduled].map((t) => [t.threadId, t]));
  // A thread list that is not live yet is empty, which would read as every thread leaving.
  const berths: Berths = ready ? reconcileBerths(stored, new Set(known.keys())) : stored;
  // A departure is kept, so a thread that returns later does not retake its berth.
  if (berths !== stored) setStored(berths);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves the berths to localStorage
  useEffect(() => writeBerths(environmentId, stored), [environmentId, stored]);

  const commit = (next: Berths) => {
    setStored(next);
    setPicking(null);
  };
  const seated = new Set(berths);
  const offBerth = view.threads.filter((thread) => !seated.has(thread.threadId));
  const hasEmpty = berths.includes(null);
  const alerts = view.scheduled.filter((thread) => NEEDS_YOU.has(thread.status)).length;
  const row = (thread: BerthThread) => (
    <OffBerthRow
      key={thread.threadId}
      thread={thread}
      subagentCount={view.subagents.get(thread.threadId)?.length ?? 0}
      hasEmpty={hasEmpty}
      picking={picking === thread.threadId}
      onOpen={onOpen}
      onEnter={(threadId, slot) => commit(enterBerth(berths, threadId, slot))}
      onPick={() => setPicking(picking === thread.threadId ? null : thread.threadId)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          已占 {berths.filter((id) => id !== null).length}/{BERTH_COUNT} 格（主力{" "}
          {berths.slice(0, PRIMARY_BERTH_COUNT).filter((id) => id !== null).length}/
          {PRIMARY_BERTH_COUNT}）
        </span>
        <span
          className={cn(view.threads.length > PRIMARY_BERTH_COUNT && "text-warning-foreground")}
        >
          活跃顶层线程 {view.threads.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {SLOTS.map((slot) => {
          const id = berths[slot] ?? null;
          const thread = id === null ? null : (known.get(id) ?? null);
          return (
            <Berth
              key={slot}
              slot={slot}
              thread={thread}
              subagents={id === null ? [] : (view.subagents.get(id) ?? [])}
              waiting={id !== null}
              onOpen={onOpen}
              onLeave={() => commit(leaveBerth(berths, slot))}
              onEnter={(threadId) => commit(enterBerth(berths, threadId, slot))}
              offBerth={offBerth}
            />
          );
        })}
      </div>
      <section aria-label="港外待入坞" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">港外待入坞（{offBerth.length}）</h2>
        {offBerth.length === 0 ? (
          <p className="text-xs text-muted-foreground">没有港外线程。</p>
        ) : (
          <ul className="flex flex-col gap-2">{offBerth.map(row)}</ul>
        )}
      </section>
      <section aria-label="定时任务线程" className="flex flex-col gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          className="w-fit"
          aria-expanded={scheduledOpen}
          onClick={() => setScheduledOpen(!scheduledOpen)}
        >
          定时任务线程（{view.scheduled.length}）{alerts > 0 ? ` · ${alerts} 条需要处理` : ""}
        </Button>
        {scheduledOpen ? (
          <ul className="flex flex-col gap-2">
            {view.scheduled.filter((thread) => !seated.has(thread.threadId)).map(row)}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
