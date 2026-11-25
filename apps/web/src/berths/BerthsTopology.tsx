/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import type { PendingThreadStatus } from "../pluginHost/pendingThreads";
import { cn } from "../lib/utils";
import type { BerthThread, VisualSeverity } from "./berths.logic";

export const STATUS_LABEL: Readonly<Record<PendingThreadStatus, string>> = {
  approval: "待审批",
  input: "待回答",
  request: "待处理",
  failed: "失败",
  working: "运行中",
  waiting: "等待中",
  done: "已完成",
};

const NODE_COLOR: Readonly<Record<PendingThreadStatus, string>> = {
  approval: "var(--destructive)",
  failed: "var(--destructive)",
  input: "var(--warning)",
  request: "var(--warning)",
  working: "var(--info)",
  done: "var(--success)",
  waiting: "var(--muted-foreground)",
};

const DOT_CLASS: Readonly<Record<PendingThreadStatus, string>> = {
  approval: "bg-destructive ring-2 ring-destructive/25",
  failed: "bg-destructive ring-2 ring-destructive/25",
  input: "bg-warning ring-2 ring-warning/25",
  request: "bg-warning ring-2 ring-warning/25",
  working: "bg-info ring-2 ring-info/25",
  done: "bg-success/80",
  waiting: "bg-muted-foreground/45",
};

const SEVERITY_BEACON: Readonly<Record<VisualSeverity, string>> = {
  critical: "bg-destructive ring-4 ring-destructive/25",
  attention: "bg-warning ring-4 ring-warning/25",
  active: "bg-info ring-4 ring-info/25",
  quiet: "bg-muted-foreground/40",
};

export function StatusBeacon({ severity, label }: { severity: VisualSeverity; label: string }) {
  return (
    <span
      aria-label={label}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", SEVERITY_BEACON[severity])}
    />
  );
}

export function StatusDot({ status }: { status: PendingThreadStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_CLASS[status])}
    />
  );
}

/** Fan-out node-edge graph: parent square on the left wired to colored subagent dots on the right. */
export function TopologyStrip({
  parentStatus,
  subagents,
  etech,
  onOpen,
}: {
  parentStatus: PendingThreadStatus;
  subagents: ReadonlyArray<BerthThread>;
  etech?: boolean;
  onOpen: (threadId: string) => void;
}) {
  if (subagents.length === 0) return null;
  const shown = subagents.slice(0, 6);
  const width = 260;
  const height = 24;
  const startX = 7;
  const startY = height / 2;
  const span = width - 48;
  const step = shown.length === 1 ? 0 : span / (shown.length - 1);
  const rootColor = etech ? "var(--warning)" : NODE_COLOR[parentStatus];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMid meet"
      className="h-6 w-full shrink-0"
      aria-label={`子代理拓扑 ${subagents.length} 项`}
    >
      {shown.map((child, index) => {
        const cx = shown.length === 1 ? startX + 54 : startX + 34 + step * index;
        const cy = index % 2 === 0 ? 7 : 17;
        const color = NODE_COLOR[child.status];
        const quiet = child.status === "done" || child.status === "waiting";
        return (
          <g key={child.threadId}>
            <line
              x1={startX + 6}
              y1={startY}
              x2={cx}
              y2={cy}
              stroke={color}
              strokeWidth={quiet ? 1.4 : 2}
              strokeDasharray={child.status === "done" ? "3 2" : undefined}
              opacity={quiet ? 0.55 : 0.95}
            />
            <circle
              cx={cx}
              cy={cy}
              r={quiet ? 4.2 : 5.4}
              fill={color}
              opacity={quiet ? 0.65 : 1}
              className="cursor-pointer"
              onClick={() => onOpen(child.threadId)}
            >
              <title>{`${child.title} · ${STATUS_LABEL[child.status]} · ${child.model}`}</title>
            </circle>
          </g>
        );
      })}
      <rect x={startX - 6} y={startY - 6} width={12} height={12} rx={3} fill={rootColor} />
    </svg>
  );
}

/** Compact dot cluster for off-berth rows so subagent health reads without opening the row. */
export function SubagentDotCluster({ subagents }: { subagents: ReadonlyArray<BerthThread> }) {
  if (subagents.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={`子代理 ${subagents.length}`}>
      {subagents.slice(0, 5).map((child) => (
        <StatusDot key={child.threadId} status={child.status} />
      ))}
      {subagents.length > 5 ? (
        <span className="text-2xs text-muted-foreground">+{subagents.length - 5}</span>
      ) : null}
    </span>
  );
}
