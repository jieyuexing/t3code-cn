/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { PendingThreadStatus } from "../pluginHost/pendingThreads";
import {
  ETECH_SLOT_COUNT,
  effectiveStatus,
  enterBerth,
  formatSubagentSummary,
  isNeedsAttention,
  isStrictEtechCandidate,
  leaveBerth,
  rankCandidates,
  reconcileBerths,
  slotCode,
  type BerthThread,
  type BerthView,
  type Berths,
} from "./berths.logic";
import { readBerths, writeBerths } from "./berthsStorage";

const SLOTS = [0, 1, 2, 3, 4, 5] as const;

const STATUS_LABEL: Readonly<Record<PendingThreadStatus, string>> = {
  approval: "待审批",
  input: "待回答",
  request: "待处理",
  failed: "失败",
  working: "运行中",
  waiting: "等待中",
  done: "已完成",
};

function StatusDot({ status }: { status: PendingThreadStatus }) {
  const tone =
    status === "approval" || status === "failed"
      ? "bg-destructive"
      : status === "input" || status === "request"
        ? "bg-warning"
        : status === "working"
          ? "bg-info"
          : "bg-muted-foreground/35";
  return (
    <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", tone)} />
  );
}

function StatusText({ status }: { status: PendingThreadStatus }) {
  const tone =
    status === "approval" || status === "failed"
      ? "font-medium text-destructive"
      : status === "input" || status === "request"
        ? "font-medium text-warning-foreground"
        : "text-muted-foreground";
  return <span className={cn("shrink-0 text-xs", tone)}>{STATUS_LABEL[status]}</span>;
}

function FocusSlotRow({
  slot,
  thread,
  subagents,
  waiting,
  expanded,
  dimmed,
  choosing,
  candidates,
  onToggleExpand,
  onToggleChoose,
  onOpen,
  onEnter,
  onLeave,
}: {
  slot: number;
  thread: BerthThread | null;
  subagents: ReadonlyArray<BerthThread>;
  waiting: boolean;
  expanded: boolean;
  dimmed: boolean;
  choosing: boolean;
  candidates: ReadonlyArray<BerthThread>;
  onToggleExpand: () => void;
  onToggleChoose: () => void;
  onOpen: (threadId: string) => void;
  onEnter: (threadId: string) => void;
  onLeave: () => void;
}) {
  const code = slotCode(slot);
  const isEtech = slot < ETECH_SLOT_COUNT;
  const label = `席位 ${code}`;

  if (thread === null) {
    return (
      <section
        aria-label={label}
        data-berth={slot + 1}
        data-slot-code={code}
        data-empty
        className={cn("transition-opacity", dimmed && !choosing && "opacity-35")}
      >
        {choosing ? (
          <div className="flex flex-col gap-2 bg-card/70 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "w-7 shrink-0 font-mono text-xs",
                    isEtech ? "font-semibold text-warning-foreground" : "text-muted-foreground",
                  )}
                >
                  {code}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isEtech ? "选择一条 ETECH 线程钉入此席位" : "选择一条线程钉入此席位"}
                </span>
              </div>
              <Button size="xs" variant="ghost-muted" onClick={onToggleChoose}>
                取消
              </Button>
            </div>
            {candidates.length === 0 ? (
              <p className="pl-10 text-xs text-muted-foreground">暂无可钉入的活跃线程。</p>
            ) : (
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto pl-9">
                {candidates.map((candidate) => (
                  <li key={candidate.threadId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => onEnter(candidate.threadId)}
                    >
                      <StatusDot status={candidate.status} />
                      <span className="min-w-0 flex-1 truncate">{candidate.displayTitle}</span>
                      {isEtech && isStrictEtechCandidate(candidate) ? (
                        <span className="shrink-0 font-mono text-2xs text-warning-foreground">
                          ETECH
                        </span>
                      ) : null}
                      <StatusText status={candidate.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={waiting}
            onClick={onToggleChoose}
            className="flex w-full items-center gap-3 px-3 py-3 text-left text-xs text-muted-foreground/70 outline-none hover:bg-accent/40 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span
              className={cn(
                "w-7 shrink-0 font-mono",
                isEtech ? "font-semibold text-warning-foreground/80" : "text-muted-foreground/60",
              )}
            >
              {code}
            </span>
            <span className="flex-1 truncate">
              {waiting ? "读取中…" : isEtech ? "空席 · ETECH 优先位" : "空席"}
            </span>
            {waiting ? null : (
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/70">
                <PlusIcon className="size-3" />
                <span>钉入</span>
              </span>
            )}
          </button>
        )}
      </section>
    );
  }

  const status = effectiveStatus(thread, subagents);
  const subSummary = formatSubagentSummary(subagents);
  const urgent = isNeedsAttention(status);

  return (
    <section
      aria-label={label}
      data-berth={slot + 1}
      data-slot-code={code}
      data-expanded={expanded ? "true" : undefined}
      className={cn(
        "transition-opacity",
        expanded && "bg-card/85",
        dimmed && "opacity-40 hover:opacity-80",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpand}
        onDoubleClick={() => onOpen(thread.threadId)}
        className="flex w-full items-center gap-3 px-3 py-3.5 text-left outline-none hover:bg-accent/35"
      >
        <span
          className={cn(
            "w-7 shrink-0 font-mono text-xs",
            isEtech ? "font-semibold text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {code}
        </span>
        <StatusDot status={status} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isEtech ? "text-base font-medium" : "text-sm font-medium",
            !urgent && status === "done" && "text-muted-foreground",
          )}
        >
          {thread.displayTitle}
        </span>
        {subSummary ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {subSummary}
          </span>
        ) : null}
        <StatusText status={status} />
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2.5 pb-3.5 pr-3 pl-13">
          {thread.snippet ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {thread.snippet}
            </p>
          ) : null}

          {subagents.length > 0 ? (
            <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto border-l-2 border-border/70 pl-3">
              {subagents.map((child) => (
                <li key={child.threadId}>
                  <button
                    type="button"
                    onClick={() => onOpen(child.threadId)}
                    className="flex w-full items-center gap-2 rounded py-0.5 text-left text-xs hover:underline"
                  >
                    <StatusDot status={child.status} />
                    <span className="min-w-0 flex-1 truncate">{child.displayTitle}</span>
                    <StatusText status={child.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <Button size="xs" variant="outline" onClick={() => onOpen(thread.threadId)}>
              <span>打开处理</span>
              <ArrowRightIcon />
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={onLeave}>
              移出
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function BerthsBoard({
  environmentId,
  view,
  ready,
  onOpen,
  mountFamilies,
}: {
  environmentId: EnvironmentId;
  view: BerthView;
  ready: boolean;
  onOpen: (threadId: string) => void;
  mountFamilies?: (threadIds: ReadonlyArray<string>) => () => void;
}) {
  const [stored, setStored] = useState(() => readBerths(environmentId));
  const [expandedSlot, setExpandedSlot] = useState<number | null>(null);
  const [choosingSlot, setChoosingSlot] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState<"unseated" | "scheduled" | null>(null);

  const pool = new Map([...view.threads, ...view.scheduled].map((t) => [t.threadId, t]));
  const berths: Berths = ready ? reconcileBerths(stored, new Set(pool.keys())) : stored;
  if (berths !== stored) setStored(berths);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the 6 fixed slot ids to localStorage
  useEffect(() => writeBerths(environmentId, stored), [environmentId, stored]);

  const seatedIds = berths.filter((id): id is string => id !== null);
  const seatedKey = seatedIds.join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts thread families for seated slots so recent failed subagents surface without server shell changes
  useEffect(() => {
    if (!mountFamilies || seatedKey.length === 0) return;
    return mountFamilies(seatedKey.split(","));
  }, [mountFamilies, seatedKey]);

  const commit = (next: Berths) => {
    setStored(next);
    setChoosingSlot(null);
  };

  const seated = new Set(seatedIds);
  const unseated = view.threads.filter((thread) => !seated.has(thread.threadId));
  const unseatedUrgent = unseated.filter((thread) =>
    isNeedsAttention(effectiveStatus(thread, view.subagents.get(thread.threadId) ?? [])),
  );
  const unseatedScheduled = view.scheduled.filter((thread) => !seated.has(thread.threadId));
  const scheduledAlerts = unseatedScheduled.filter((thread) =>
    isNeedsAttention(effectiveStatus(thread, view.subagents.get(thread.threadId) ?? [])),
  ).length;
  const hasEmpty = berths.includes(null);

  const activeExpanded =
    expandedSlot !== null && berths[expandedSlot] !== null ? expandedSlot : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both px-6 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex flex-col divide-y divide-border/50 border-y border-border/50">
          {SLOTS.map((slot) => {
            const id = berths[slot] ?? null;
            const thread = id === null ? null : (pool.get(id) ?? null);
            const isChoosing = choosingSlot === slot;
            const candidates = isChoosing
              ? rankCandidates(unseated, view.subagents, slot < ETECH_SLOT_COUNT)
              : [];
            return (
              <FocusSlotRow
                key={slot}
                slot={slot}
                thread={thread}
                subagents={id === null ? [] : (view.subagents.get(id) ?? [])}
                waiting={id !== null}
                expanded={activeExpanded === slot}
                dimmed={activeExpanded !== null && activeExpanded !== slot}
                choosing={isChoosing}
                candidates={candidates}
                onToggleExpand={() => {
                  setChoosingSlot(null);
                  setExpandedSlot(activeExpanded === slot ? null : slot);
                }}
                onToggleChoose={() => {
                  setExpandedSlot(null);
                  setChoosingSlot(isChoosing ? null : slot);
                }}
                onOpen={onOpen}
                onEnter={(threadId) => {
                  commit(enterBerth(berths, threadId, slot));
                  setExpandedSlot(slot);
                }}
                onLeave={() => {
                  commit(leaveBerth(berths, slot));
                  if (activeExpanded === slot) setExpandedSlot(null);
                }}
              />
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {unseated.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={drawerOpen === "unseated"}
              onClick={() => setDrawerOpen(drawerOpen === "unseated" ? null : "unseated")}
            >
              未钉线程（{unseated.length}）
              {unseatedUrgent.length > 0 ? ` · ${unseatedUrgent.length} 条待处理` : ""}
            </Button>
          ) : null}
          {unseatedScheduled.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={drawerOpen === "scheduled"}
              onClick={() => setDrawerOpen(drawerOpen === "scheduled" ? null : "scheduled")}
            >
              定时任务（{unseatedScheduled.length}）
              {scheduledAlerts > 0 ? ` · ${scheduledAlerts} 条待处理` : ""}
            </Button>
          ) : null}
        </div>

        {drawerOpen === "unseated" && unseated.length > 0 ? (
          <section aria-label="未钉线程" className="flex flex-col gap-1">
            <ul className="flex flex-col divide-y divide-border/40">
              {rankCandidates(unseated, view.subagents, false).map((thread) => {
                const status = effectiveStatus(thread, view.subagents.get(thread.threadId) ?? []);
                return (
                  <li key={thread.threadId} className="flex items-center gap-2.5 py-2 text-xs">
                    <StatusDot status={status} />
                    <button
                      type="button"
                      onClick={() => onOpen(thread.threadId)}
                      className="min-w-0 flex-1 truncate text-left hover:underline"
                    >
                      {thread.displayTitle}
                    </button>
                    <StatusText status={status} />
                    {hasEmpty ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() => commit(enterBerth(berths, thread.threadId))}
                      >
                        钉入空位
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {drawerOpen === "scheduled" && unseatedScheduled.length > 0 ? (
          <section aria-label="定时任务" className="flex flex-col gap-1">
            <ul className="flex flex-col divide-y divide-border/40">
              {unseatedScheduled.map((thread) => {
                const status = effectiveStatus(thread, view.subagents.get(thread.threadId) ?? []);
                return (
                  <li key={thread.threadId} className="flex items-center gap-2.5 py-2 text-xs">
                    <StatusDot status={status} />
                    <button
                      type="button"
                      onClick={() => onOpen(thread.threadId)}
                      className="min-w-0 flex-1 truncate text-left hover:underline"
                    >
                      {thread.displayTitle}
                    </button>
                    <StatusText status={status} />
                    {hasEmpty ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() => commit(enterBerth(berths, thread.threadId))}
                      >
                        钉入空位
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
