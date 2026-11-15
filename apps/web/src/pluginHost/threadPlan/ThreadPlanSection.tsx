import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  ListTodoIcon,
} from "lucide-react";
import { useState } from "react";

import { ThreadDetailsControl } from "~/components/chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "~/components/chat/threadDetailsPanelStyles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  formatPlanElapsed,
  groupPlanSteps,
  isPlanComplete,
  planRows,
  previewPendingSteps,
  type PlanDensity,
  type PlanStep,
} from "./threadPlan.logic";
import { useThreadPlan, useThreadPlanProgress } from "./useThreadPlan";

const STEP_ROW_CLASS = "flex items-start gap-2.5 rounded-lg px-2.5 py-1 text-xs/5";
const STEP_ICON_CLASS = "mt-0.5 size-4 shrink-0";
const LIST_CLASS = "m-0 max-h-48 list-none overflow-y-auto p-0";

function Elapsed({ anchor }: { anchor: string }) {
  const nowMinute = useNowMinute();
  const elapsedMs = Date.parse(`${nowMinute}:00Z`) - Date.parse(anchor);
  return (
    <span className="ms-auto shrink-0 text-2xs/5 tabular-nums text-muted-foreground">
      {formatPlanElapsed(elapsedMs)}
    </span>
  );
}

function PlanTitle({ threadRef }: { threadRef: ScopedThreadRef }) {
  const progress = useThreadPlanProgress(threadRef);
  if (progress === null) return null;
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 px-2.5">
      {progress.complete ? (
        <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
      ) : (
        <ListTodoIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      )}
      <span className="min-w-0 truncate text-sm font-medium text-foreground/80">
        {progress.complete ? "Plan complete" : "Plan"}{" "}
        <span className="font-normal tabular-nums text-muted-foreground">
          {progress.done}/{progress.total}
        </span>
      </span>
    </div>
  );
}

function StepRow({
  step,
  live,
  tone,
}: {
  step: PlanStep;
  live: boolean;
  tone: "done" | "running" | "pending";
}) {
  const Icon = tone === "done" ? CheckIcon : tone === "running" ? CircleDotIcon : CircleIcon;
  return (
    <li className={cn(STEP_ROW_CLASS, tone === "running" && "bg-primary/8")} data-plan-step={tone}>
      <Icon
        aria-hidden
        className={cn(
          STEP_ICON_CLASS,
          tone === "done" && "text-success",
          tone === "running" && "text-primary",
          tone === "pending" && "text-muted-foreground/40",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          delay={400}
          render={
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                tone === "running" ? "font-medium text-foreground/90" : "text-muted-foreground",
              )}
            />
          }
        >
          <span className="sr-only">{tone}: </span>
          {step.text}
        </TooltipTrigger>
        <TooltipPopup side="left">{step.text}</TooltipPopup>
      </Tooltip>
      {tone === "running" && live && step.durationAnchorAt !== undefined ? (
        <Elapsed anchor={step.durationAnchorAt} />
      ) : null}
      {tone === "done" && step.durationMs !== undefined ? (
        <span className="ms-auto shrink-0 text-2xs/5 tabular-nums text-muted-foreground/60">
          {formatDuration(step.durationMs)}
        </span>
      ) : null}
    </li>
  );
}

function ToggleRow({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: string;
}) {
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <ThreadDetailsControl
      variant="ghost"
      size="sm"
      part="row"
      tone="muted"
      aria-expanded={expanded}
      onClick={onToggle}
      className="w-full active:scale-100"
    >
      <Chevron aria-hidden className="size-4 shrink-0" />
      {children}
    </ThreadDetailsControl>
  );
}

/** The newest todo list of a thread, at the top of the details card. Renders nothing without one. */
export function ThreadPlanSection({
  threadRef,
  density,
}: {
  threadRef: ScopedThreadRef;
  density: PlanDensity;
}) {
  const selected = useThreadPlan(threadRef);
  const [doneOpen, setDoneOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  if (selected === null) return null;
  const { plan, live } = selected;
  const groups = groupPlanSteps(plan.steps);
  const complete = isPlanComplete(plan);
  const rows = planRows(density);
  const pending = previewPendingSteps(groups.pending, pendingOpen);
  const percent = Math.round((groups.done.length / plan.steps.length) * 100);
  // A running step is listed with the others in full; compact and essential keep only the current one.
  const showCurrentOnly = rows.current && !rows.lists && !complete && groups.current !== null;

  return (
    <section
      aria-label="Plan"
      data-thread-plan
      // The Workspace section that follows has no rule of its own.
      className="border-border/65 px-2 pt-2 pb-2.5 [&:has(~section[aria-label=Workspace])]:border-b"
    >
      <div className="flex flex-col">
        <PlanTitle threadRef={threadRef} />
        {rows.bar && !complete ? (
          <div
            role="progressbar"
            aria-label="Plan progress"
            aria-valuemin={0}
            aria-valuemax={plan.steps.length}
            aria-valuenow={groups.done.length}
            className="mx-2.5 mb-1 h-0.5 overflow-hidden rounded-full bg-foreground/10"
          >
            <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {showCurrentOnly && groups.current ? (
          <ul className="m-0 list-none p-0">
            <StepRow
              step={groups.current}
              live={live}
              tone={groups.current.status === "running" ? "running" : "pending"}
            />
          </ul>
        ) : null}
        {rows.lists && !complete ? (
          <>
            {groups.done.length > 0 ? (
              <>
                <ToggleRow expanded={doneOpen} onToggle={() => setDoneOpen(!doneOpen)}>
                  {`${groups.done.length} done`}
                </ToggleRow>
                {doneOpen ? (
                  <ul data-thread-plan-list className={LIST_CLASS}>
                    {groups.done.map((step) => (
                      <StepRow key={step.id} step={step} live={live} tone="done" />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {groups.running.length > 0 ? (
              <ul className="m-0 list-none p-0">
                {groups.running.map((step) => (
                  <StepRow key={step.id} step={step} live={live} tone="running" />
                ))}
              </ul>
            ) : null}
            {pending.shown.length > 0 ? (
              <ul data-thread-plan-list className={LIST_CLASS}>
                {pending.shown.map((step) => (
                  <StepRow key={step.id} step={step} live={live} tone="pending" />
                ))}
              </ul>
            ) : null}
            {pending.hidden > 0 || pendingOpen ? (
              <ToggleRow expanded={pendingOpen} onToggle={() => setPendingOpen(!pendingOpen)}>
                {pendingOpen ? "Show less" : `+${pending.hidden} more`}
              </ToggleRow>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
