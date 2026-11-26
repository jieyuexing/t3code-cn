/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@ui-sdk/react/accordion";
import { Button as UiButton } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@ui-sdk/react/combobox";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { registerBerthsWebMcp } from "./berthsAgent";
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

function EmptySlotRow({
  slot,
  waiting,
  dimmed,
  candidates,
  inputRef,
  onEnter,
}: {
  slot: number;
  waiting: boolean;
  dimmed: boolean;
  candidates: ReadonlyArray<BerthThread>;
  inputRef: (el: HTMLInputElement | null) => void;
  onEnter: (threadId: string) => void;
}) {
  const code = slotCode(slot);
  const isEtech = slot < ETECH_SLOT_COUNT;
  const label = `席位 ${code}`;

  return (
    <section
      aria-label={label}
      data-berth={slot + 1}
      data-slot-code={code}
      data-empty
      className={cn("transition-opacity", dimmed && "opacity-35 hover:opacity-80")}
    >
      <Combobox<string>
        defaultValue={null}
        disabled={waiting}
        onValueChange={(next) => {
          if (typeof next === "string" && next.length > 0) onEnter(next);
        }}
      >
        <div className="flex w-full items-center gap-3 px-3 py-3 text-xs">
          <ComboboxLabel className="sr-only">{`钉入席位 ${code}`}</ComboboxLabel>
          <span
            aria-hidden="true"
            className={cn(
              "w-7 shrink-0 font-mono",
              isEtech ? "font-semibold text-warning-foreground/80" : "text-muted-foreground/60",
            )}
          >
            {code}
          </span>
          <ComboboxInput
            ref={inputRef}
            placeholder={
              waiting
                ? "读取中…"
                : isEtech
                  ? "空席 · ETECH 优先位（点击或输入关键词钉入）"
                  : "空席（点击或输入关键词钉入）"
            }
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/65 disabled:cursor-default"
          />
          {waiting ? null : (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/60"
            >
              <PlusIcon className="size-3" />
              <span>钉入</span>
            </span>
          )}
        </div>
        <ComboboxContent className="z-50 mt-1 max-h-56 min-w-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <ComboboxEmpty className="px-2 py-2 text-xs text-muted-foreground">
            没有匹配的活跃线程。
          </ComboboxEmpty>
          <ComboboxList className="flex flex-col gap-0.5">
            {candidates.map((candidate) => (
              <ComboboxItem
                key={candidate.threadId}
                value={candidate.threadId}
                label={candidate.displayTitle}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-highlighted:bg-accent"
              >
                <StatusDot status={candidate.status} />
                <span className="min-w-0 flex-1 truncate">{candidate.displayTitle}</span>
                {isEtech && isStrictEtechCandidate(candidate) ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 font-mono text-2xs text-warning-foreground"
                  >
                    ETECH
                  </span>
                ) : null}
                <span aria-hidden="true" className="shrink-0">
                  <StatusText status={candidate.status} />
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </section>
  );
}

function OccupiedSlotRow({
  slot,
  thread,
  subagents,
  expanded,
  dimmed,
  onOpen,
  onLeave,
}: {
  slot: number;
  thread: BerthThread;
  subagents: ReadonlyArray<BerthThread>;
  expanded: boolean;
  dimmed: boolean;
  onOpen: (threadId: string) => void;
  onLeave: () => void;
}) {
  const code = slotCode(slot);
  const isEtech = slot < ETECH_SLOT_COUNT;
  const label = `席位 ${code}`;
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
      <AccordionItem value={code}>
        <AccordionHeader className="m-0">
          <AccordionTrigger
            onDoubleClick={() => onOpen(thread.threadId)}
            className="flex w-full items-center gap-3 px-3 py-3.5 text-left outline-none hover:bg-accent/35 focus-visible:bg-accent/45"
          >
            <span
              className={cn(
                "w-7 shrink-0 font-mono text-xs",
                isEtech ? "font-semibold text-warning-foreground" : "text-muted-foreground",
              )}
            >
              {code}{" "}
            </span>
            <StatusDot status={status} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isEtech ? "text-base font-medium" : "text-sm font-medium",
                !urgent && status === "done" && "text-muted-foreground",
              )}
            >
              {thread.displayTitle}{" "}
            </span>
            {subSummary ? (
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {subSummary}{" "}
              </span>
            ) : null}
            <StatusText status={status} />
          </AccordionTrigger>
        </AccordionHeader>

        <AccordionPanel className="flex flex-col gap-2.5 pb-3.5 pr-3 pl-13">
          {thread.snippet ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {thread.snippet}
            </p>
          ) : null}

          {subagents.length > 0 ? (
            <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto border-l-2 border-border/70 pl-3">
              {subagents.map((child) => (
                <li key={child.threadId}>
                  <UiButton
                    aria-label={`打开子代理：${child.displayTitle}`}
                    onClick={() => onOpen(child.threadId)}
                    className="flex w-full items-center gap-2 rounded py-0.5 text-left text-xs outline-none hover:underline focus-visible:underline"
                  >
                    <StatusDot status={child.status} />
                    <span className="min-w-0 flex-1 truncate">{child.displayTitle}</span>
                    <StatusText status={child.status} />
                  </UiButton>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <UiButton
              aria-label={`打开处理：${thread.displayTitle}`}
              onClick={() => onOpen(thread.threadId)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span>打开处理</span>
              <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </UiButton>
            <UiButton
              aria-label={`移出席位 ${code}`}
              data-agent-confirm={`将「${thread.displayTitle}」移出席位 ${code}`}
              onClick={onLeave}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              移出
            </UiButton>
          </div>
        </AccordionPanel>
      </AccordionItem>
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
  const [unseatedOpen, setUnseatedOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const emptyInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const pool = new Map([...view.threads, ...view.scheduled].map((t) => [t.threadId, t]));
  const berths: Berths = ready ? reconcileBerths(stored, new Set(pool.keys())) : stored;
  if (berths !== stored) setStored(berths);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the 6 fixed slot ids to localStorage
  useEffect(() => writeBerths(environmentId, stored), [environmentId, stored]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers ui-sdk WebMCP agent bridge when the host browser supports document.modelContext
  useEffect(() => registerBerthsWebMcp(), []);

  const seatedIds = berths.filter((id): id is string => id !== null);
  const seatedKey = seatedIds.join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts thread families for seated slots so recent failed subagents surface without server shell changes
  useEffect(() => {
    if (!mountFamilies || seatedKey.length === 0) return;
    return mountFamilies(seatedKey.split(","));
  }, [mountFamilies, seatedKey]);

  const activeExpanded =
    expandedSlot !== null && berths[expandedSlot] !== null ? expandedSlot : null;

  const activateSlot = (slot: number) => {
    const id = berths[slot] ?? null;
    if (id !== null && pool.has(id)) {
      setExpandedSlot(activeExpanded === slot ? null : slot);
      return;
    }
    setExpandedSlot(null);
    emptyInputRefs.current[slot]?.focus();
  };

  useShortcut("1", () => activateSlot(0));
  useShortcut("2", () => activateSlot(1));
  useShortcut("3", () => activateSlot(2));
  useShortcut("4", () => activateSlot(3));
  useShortcut("5", () => activateSlot(4));
  useShortcut("6", () => activateSlot(5));
  useShortcut("escape", () => setExpandedSlot(null), { when: () => activeExpanded !== null });

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

  const etechCandidates = rankCandidates(unseated, view.subagents, true);
  const personalCandidates = rankCandidates(unseated, view.subagents, false);
  const accordionValue = activeExpanded === null ? [] : [slotCode(activeExpanded)];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both px-6 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <Accordion
          aria-label="专注席位"
          collapsible
          value={accordionValue}
          onValueChange={(next) => {
            const code = next[0];
            setExpandedSlot(
              code === undefined ? null : (SLOTS.find((s) => slotCode(s) === code) ?? null),
            );
          }}
          className="flex flex-col divide-y divide-border/50 border-y border-border/50"
        >
          {SLOTS.map((slot) => {
            const id = berths[slot] ?? null;
            const thread = id === null ? null : (pool.get(id) ?? null);
            if (thread === null) {
              return (
                <EmptySlotRow
                  key={slot}
                  slot={slot}
                  waiting={id !== null}
                  dimmed={activeExpanded !== null}
                  candidates={slot < ETECH_SLOT_COUNT ? etechCandidates : personalCandidates}
                  inputRef={(el) => {
                    emptyInputRefs.current[slot] = el;
                  }}
                  onEnter={(threadId) => {
                    setStored(enterBerth(berths, threadId, slot));
                    setExpandedSlot(slot);
                  }}
                />
              );
            }
            return (
              <OccupiedSlotRow
                key={slot}
                slot={slot}
                thread={thread}
                subagents={view.subagents.get(thread.threadId) ?? []}
                expanded={activeExpanded === slot}
                dimmed={activeExpanded !== null && activeExpanded !== slot}
                onOpen={onOpen}
                onLeave={() => {
                  setStored(leaveBerth(berths, slot));
                  if (activeExpanded === slot) setExpandedSlot(null);
                }}
              />
            );
          })}
        </Accordion>

        <div className="flex flex-col gap-3">
          {unseated.length > 0 ? (
            <Collapsible open={unseatedOpen} onOpenChange={(open) => setUnseatedOpen(open)}>
              <CollapsibleTrigger className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                未钉线程（{unseated.length}）
                {unseatedUrgent.length > 0 ? ` · ${unseatedUrgent.length} 条待处理` : ""}
              </CollapsibleTrigger>
              <CollapsiblePanel className="mt-1">
                <section aria-label="未钉线程">
                  <ul className="flex flex-col divide-y divide-border/40">
                    {personalCandidates.map((thread) => {
                      const status = effectiveStatus(
                        thread,
                        view.subagents.get(thread.threadId) ?? [],
                      );
                      return (
                        <li
                          key={thread.threadId}
                          className="flex items-center gap-2.5 py-2 text-xs"
                        >
                          <StatusDot status={status} />
                          <UiButton
                            aria-label={`打开未钉线程：${thread.displayTitle}`}
                            onClick={() => onOpen(thread.threadId)}
                            className="min-w-0 flex-1 truncate text-left outline-none hover:underline focus-visible:underline"
                          >
                            {thread.displayTitle}
                          </UiButton>
                          <StatusText status={status} />
                          {hasEmpty ? (
                            <UiButton
                              aria-label={`钉入空位：${thread.displayTitle}`}
                              onClick={() => setStored(enterBerth(berths, thread.threadId))}
                              className="inline-flex h-6 items-center rounded px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
                            >
                              钉入空位
                            </UiButton>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}

          {unseatedScheduled.length > 0 ? (
            <Collapsible open={scheduledOpen} onOpenChange={(open) => setScheduledOpen(open)}>
              <CollapsibleTrigger className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                定时任务（{unseatedScheduled.length}）
                {scheduledAlerts > 0 ? ` · ${scheduledAlerts} 条待处理` : ""}
              </CollapsibleTrigger>
              <CollapsiblePanel className="mt-1">
                <section aria-label="定时任务">
                  <ul className="flex flex-col divide-y divide-border/40">
                    {unseatedScheduled.map((thread) => {
                      const status = effectiveStatus(
                        thread,
                        view.subagents.get(thread.threadId) ?? [],
                      );
                      return (
                        <li
                          key={thread.threadId}
                          className="flex items-center gap-2.5 py-2 text-xs"
                        >
                          <StatusDot status={status} />
                          <UiButton
                            aria-label={`打开定时任务：${thread.displayTitle}`}
                            onClick={() => onOpen(thread.threadId)}
                            className="min-w-0 flex-1 truncate text-left outline-none hover:underline focus-visible:underline"
                          >
                            {thread.displayTitle}
                          </UiButton>
                          <StatusText status={status} />
                          {hasEmpty ? (
                            <UiButton
                              aria-label={`钉入定时任务：${thread.displayTitle}`}
                              onClick={() => setStored(enterBerth(berths, thread.threadId))}
                              className="inline-flex h-6 items-center rounded px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
                            >
                              钉入空位
                            </UiButton>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </div>
      </div>
    </div>
  );
}
