/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import {
  BERTH_COUNT,
  PRIMARY_BERTH_COUNT,
  effectiveSeverity,
  enterBerth,
  leaveBerth,
  partitionBerthThreads,
  reconcileBerths,
  type BerthThread,
  type BerthView,
  type Berths,
  type EtechOverrides,
  type VisualSeverity,
} from "./berths.logic";
import { readBerths, readEtechOverrides, writeBerths, writeEtechOverrides } from "./berthsStorage";
import {
  STATUS_LABEL,
  StatusBeacon,
  StatusDot,
  SubagentDotCluster,
  TopologyStrip,
} from "./BerthsTopology";

const SLOTS = [0, 1, 2, 3, 4, 5] as const;

const CARD_TONE: Readonly<Record<VisualSeverity, string>> = {
  critical: "border-destructive/80 border-l-4 bg-card",
  attention: "border-warning/80 border-l-4 bg-card",
  active: "border-info/75 border-l-4 bg-card",
  quiet: "border-border/70 bg-card/55 opacity-75",
};

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

function SubagentList({
  subagents,
  onOpen,
}: {
  subagents: ReadonlyArray<BerthThread>;
  onOpen: (threadId: string) => void;
}) {
  if (subagents.length === 0) return null;
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
      {subagents.map((child) => (
        <li key={child.threadId} className="flex items-center gap-1.5 text-xs leading-5">
          <StatusDot status={child.status} />
          <OpenButton thread={child} onOpen={onOpen} className="flex-1" />
          <span className="shrink-0 text-2xs text-muted-foreground">{child.model}</span>
        </li>
      ))}
    </ul>
  );
}

function EtechCard({
  thread,
  subagents,
  onOpen,
  onDemote,
}: {
  thread: BerthThread;
  subagents: ReadonlyArray<BerthThread>;
  onOpen: (threadId: string) => void;
  onDemote: () => void;
}) {
  const severity = effectiveSeverity(thread, subagents);
  return (
    <article
      data-etech-card={thread.threadId}
      data-severity={severity}
      className={cn(
        "flex h-40 min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg border p-2.5",
        CARD_TONE[severity],
      )}
    >
      <div className="flex items-center gap-2">
        <StatusBeacon severity={severity} label={STATUS_LABEL[thread.status]} />
        <OpenButton thread={thread} onOpen={onOpen} className="flex-1 text-sm font-semibold" />
        <Button size="xs" variant="ghost-muted" onClick={onDemote}>
          移出优先
        </Button>
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {STATUS_LABEL[thread.status]} · {thread.model}
        {thread.branch === null ? "" : ` · ${thread.branch}`}
      </p>
      <TopologyStrip parentStatus={thread.status} subagents={subagents} etech onOpen={onOpen} />
      <SubagentList subagents={subagents} onOpen={onOpen} />
      {subagents.length === 0 && severity === "active" ? (
        <div className="mt-auto h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-3/5 rounded-full bg-info" />
        </div>
      ) : null}
    </article>
  );
}

function BerthCard({
  slot,
  thread,
  subagents,
  waiting,
  choosing,
  offBerth,
  onOpen,
  onLeave,
  onPromoteEtech,
  onToggleChoose,
  onEnter,
}: {
  slot: number;
  thread: BerthThread | null;
  subagents: ReadonlyArray<BerthThread>;
  waiting: boolean;
  choosing: boolean;
  offBerth: ReadonlyArray<BerthThread>;
  onOpen: (threadId: string) => void;
  onLeave: () => void;
  onPromoteEtech: (threadId: string) => void;
  onToggleChoose: () => void;
  onEnter: (threadId: string) => void;
}) {
  const tag = `泊位 ${slot + 1}`;
  const role = slot < PRIMARY_BERTH_COUNT ? "主力" : "副位";

  if (thread === null) {
    return (
      <section
        aria-label={tag}
        data-berth={slot + 1}
        data-empty
        className="flex h-44 min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-dashed border-border/80 p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {tag} · {waiting ? "读取中" : "空闲"} · {role}
          </p>
          {choosing ? (
            <Button size="xs" variant="ghost-muted" onClick={onToggleChoose}>
              取消
            </Button>
          ) : null}
        </div>
        {waiting ? null : choosing ? (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {offBerth.length === 0 ? (
              <p className="text-xs text-muted-foreground">没有可入坞的港外线程。</p>
            ) : (
              offBerth.map((candidate) => (
                <button
                  key={candidate.threadId}
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => onEnter(candidate.threadId)}
                >
                  <StatusDot status={candidate.status} />
                  <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Button
              size="xs"
              variant="outline"
              disabled={offBerth.length === 0}
              onClick={onToggleChoose}
            >
              <PlusIcon />
              <span>{offBerth.length === 0 ? "暂无港外线程" : "选线程入坞"}</span>
            </Button>
          </div>
        )}
      </section>
    );
  }

  const severity = effectiveSeverity(thread, subagents);
  return (
    <section
      aria-label={tag}
      data-berth={slot + 1}
      data-severity={severity}
      className={cn(
        "flex h-44 min-w-0 flex-col gap-1 overflow-hidden rounded-lg border p-2.5",
        CARD_TONE[severity],
      )}
    >
      <div className="flex items-center gap-1.5">
        <StatusBeacon severity={severity} label={STATUS_LABEL[thread.status]} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {tag} · {role}
        </span>
        <div className="min-w-0 flex-1" />
        <Button size="xs" variant="ghost-muted" onClick={() => onPromoteEtech(thread.threadId)}>
          置顶 ETECH
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={onLeave}>
          移出
        </Button>
      </div>
      <OpenButton thread={thread} onOpen={onOpen} className="text-sm font-medium" />
      <p className="truncate text-xs text-muted-foreground">
        {STATUS_LABEL[thread.status]} · {thread.model}
        {thread.branch === null ? "" : ` · ${thread.branch}`}
      </p>
      <TopologyStrip parentStatus={thread.status} subagents={subagents} onOpen={onOpen} />
      <SubagentList subagents={subagents} onOpen={onOpen} />
      {subagents.length === 0 && severity === "active" ? (
        <div className="mt-auto h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-3/5 rounded-full bg-info" />
        </div>
      ) : null}
    </section>
  );
}

function OffBerthRow({
  thread,
  subagents,
  hasEmpty,
  picking,
  onOpen,
  onEnter,
  onPick,
  onPromoteEtech,
}: {
  thread: BerthThread;
  subagents: ReadonlyArray<BerthThread>;
  hasEmpty: boolean;
  picking: boolean;
  onOpen: (threadId: string) => void;
  onEnter: (threadId: string, slot?: number) => void;
  onPick: () => void;
  onPromoteEtech?: () => void;
}) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot status={thread.status} />
        <OpenButton thread={thread} onOpen={onOpen} className="flex-1" />
        <SubagentDotCluster subagents={subagents} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {STATUS_LABEL[thread.status]}
        </span>
        {onPromoteEtech ? (
          <Button size="xs" variant="ghost-muted" onClick={onPromoteEtech}>
            标 ETECH
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          onClick={hasEmpty ? () => onEnter(thread.threadId) : onPick}
        >
          入泊位
        </Button>
      </div>
      {picking ? (
        <div className="flex items-center gap-1 pl-4">
          {SLOTS.map((slot) => (
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
  const [etechOverrides, setEtechOverrides] = useState<EtechOverrides>(() =>
    readEtechOverrides(environmentId),
  );
  const [picking, setPicking] = useState<string | null>(null);
  const [choosingSlot, setChoosingSlot] = useState<number | null>(null);
  const [scheduledOpen, setScheduledOpen] = useState(false);

  const { etech, personal } = partitionBerthThreads(view.threads, view.subagents, etechOverrides);
  const personalPool = new Map([...personal, ...view.scheduled].map((t) => [t.threadId, t]));
  // Keep saved berths until live, and drop threads that left play or were promoted to the ETECH zone.
  const berths: Berths = ready ? reconcileBerths(stored, new Set(personalPool.keys())) : stored;
  if (berths !== stored) setStored(berths);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves fixed berth slots to localStorage
  useEffect(() => writeBerths(environmentId, stored), [environmentId, stored]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves manual ETECH priority overrides to localStorage
  useEffect(
    () => writeEtechOverrides(environmentId, etechOverrides),
    [environmentId, etechOverrides],
  );

  const commit = (next: Berths) => {
    setStored(next);
    setPicking(null);
    setChoosingSlot(null);
  };
  const setEtechFlag = (threadId: string, value: boolean) => {
    setEtechOverrides((prev) => ({ ...prev, [threadId]: value }));
    if (value) {
      const idx = berths.indexOf(threadId);
      if (idx >= 0) setStored(leaveBerth(berths, idx));
    }
    setPicking(null);
    setChoosingSlot(null);
  };

  const seated = new Set(berths);
  const offBerth = personal.filter((thread) => !seated.has(thread.threadId));
  const hasEmpty = berths.includes(null);
  const alerts = view.scheduled.filter(
    (thread) =>
      thread.status === "approval" ||
      thread.status === "input" ||
      thread.status === "request" ||
      thread.status === "failed",
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {etech.length > 0 ? (
          <span className="font-medium text-warning-foreground">ETECH 优先 {etech.length}</span>
        ) : null}
        <span>
          个人泊位 {berths.filter((id) => id !== null).length}/{BERTH_COUNT}（主力{" "}
          {berths.slice(0, PRIMARY_BERTH_COUNT).filter((id) => id !== null).length}/
          {PRIMARY_BERTH_COUNT}）
        </span>
        <span className={cn(personal.length > PRIMARY_BERTH_COUNT && "text-warning-foreground")}>
          个人活跃 {personal.length}
        </span>
      </div>

      {etech.length > 0 ? (
        <section
          aria-label="ETECH 优先区"
          className="flex flex-col gap-2 rounded-lg border-2 border-warning/70 border-l-8 bg-warning/10 p-2.5"
        >
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-warning-foreground">
            <span>▲ ETECH 优先区（权重最高 · 自动置顶）</span>
            <span>{etech.length} 条活跃</span>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {etech.map((thread) => (
              <EtechCard
                key={thread.threadId}
                thread={thread}
                subagents={view.subagents.get(thread.threadId) ?? []}
                onOpen={onOpen}
                onDemote={() => setEtechFlag(thread.threadId, false)}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
        {SLOTS.map((slot) => {
          const id = berths[slot] ?? null;
          const thread = id === null ? null : (personalPool.get(id) ?? null);
          return (
            <BerthCard
              key={slot}
              slot={slot}
              thread={thread}
              subagents={id === null ? [] : (view.subagents.get(id) ?? [])}
              waiting={id !== null}
              choosing={choosingSlot === slot}
              offBerth={offBerth}
              onOpen={onOpen}
              onLeave={() => commit(leaveBerth(berths, slot))}
              onPromoteEtech={(threadId) => setEtechFlag(threadId, true)}
              onToggleChoose={() => setChoosingSlot(choosingSlot === slot ? null : slot)}
              onEnter={(threadId) => commit(enterBerth(berths, threadId, slot))}
            />
          );
        })}
      </div>

      <section aria-label="港外待入坞" className="flex flex-col gap-1.5">
        <h2 className="text-xs font-medium text-muted-foreground">
          港外待入坞（{offBerth.length}）
        </h2>
        {offBerth.length === 0 ? (
          <p className="text-xs text-muted-foreground">没有港外线程。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {offBerth.map((thread) => (
              <OffBerthRow
                key={thread.threadId}
                thread={thread}
                subagents={view.subagents.get(thread.threadId) ?? []}
                hasEmpty={hasEmpty}
                picking={picking === thread.threadId}
                onOpen={onOpen}
                onEnter={(threadId, slot) => commit(enterBerth(berths, threadId, slot))}
                onPick={() => setPicking(picking === thread.threadId ? null : thread.threadId)}
                onPromoteEtech={() => setEtechFlag(thread.threadId, true)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="定时任务线程" className="flex flex-col gap-1.5">
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
          <ul className="flex flex-col gap-1.5">
            {view.scheduled
              .filter((thread) => !seated.has(thread.threadId))
              .map((thread) => (
                <OffBerthRow
                  key={thread.threadId}
                  thread={thread}
                  subagents={view.subagents.get(thread.threadId) ?? []}
                  hasEmpty={hasEmpty}
                  picking={picking === thread.threadId}
                  onOpen={onOpen}
                  onEnter={(threadId, slot) => commit(enterBerth(berths, threadId, slot))}
                  onPick={() => setPicking(picking === thread.threadId ? null : thread.threadId)}
                />
              ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
