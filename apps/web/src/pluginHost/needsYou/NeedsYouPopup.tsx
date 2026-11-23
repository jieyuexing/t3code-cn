/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy, outside upstream catalogs */
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, type PopoverCreateHandle } from "~/components/ui/popover";
import { RefreshIcon } from "~/components/ui/refresh-icon";

import {
  FOLLOW_RECOMMENDATION,
  KIND_LABELS,
  formatWait,
  type NeedsYouEntry,
  type NeedsYouKind,
} from "./needsYou.logic";
import { InboxTab, WakeTab, type GtdTab } from "./NeedsYouGtdSections";
import { gtdSummary } from "./needsYouGtd.logic";
import { useNeedsYouActions } from "./useNeedsYouActions";
import { useNeedsYouGtd } from "./useNeedsYouGtd";

const KIND_BADGE: Readonly<Record<NeedsYouKind, ComponentProps<typeof Badge>["variant"]>> = {
  reply: "info",
  question: "info",
  approval: "warning",
  request: "warning",
  failed: "error",
};

type Actions = ReturnType<typeof useNeedsYouActions>;

function NeedsYouRow(props: { readonly entry: NeedsYouEntry; readonly actions: Actions }) {
  const { entry, actions } = props;
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (label: string, action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const failure = await action();
    setBusy(false);
    if (failure === null) setAnswered(label);
    else setError(failure);
  };
  // oxlint-disable-next-line react/purity -- the wait is as of this render
  const now = Date.now();
  const waited =
    entry.thread.waitingSince === null ? "" : `等了 ${formatWait(entry.thread.waitingSince, now)}`;
  const send = (text: string) => run("已发送，线程处理中", () => actions.send(entry, text));
  const typed = draft.trim();

  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{entry.thread.title}</span>
        <Badge variant={KIND_BADGE[entry.kind]}>{KIND_LABELS[entry.kind]}</Badge>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{waited}</span>
      </div>
      <p className="line-clamp-2 text-muted-foreground text-sm">{entry.text}</p>
      {answered !== null ? (
        <p className="text-muted-foreground text-xs">{answered}</p>
      ) : (
        <>
          {entry.kind === "reply" ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void send(FOLLOW_RECOMMENDATION)}
              >
                {FOLLOW_RECOMMENDATION}
              </Button>
              <Input
                size="compact"
                className="min-w-0 flex-1"
                aria-label="自定义回复"
                placeholder="回复这条线程…"
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && typed !== "") {
                    void send(typed);
                  }
                }}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-1.5">
            {entry.kind === "approval" ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run("已允许", () => actions.decide(entry, "accept"))}
                >
                  允许一次
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  disabled={busy}
                  onClick={() => void run("已拒绝", () => actions.decide(entry, "decline"))}
                >
                  拒绝
                </Button>
              </>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-destructive-foreground text-xs">
              {error}
            </span>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void run("已稍后处理", () => actions.snooze(entry))}
            >
              稍后处理
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => actions.open(entry.thread.threadId)}
            >
              打开线程
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

function PendingList(props: {
  readonly entries: ReadonlyArray<NeedsYouEntry>;
  readonly actions: Actions;
}) {
  if (props.entries.length === 0) {
    return <p className="px-3 py-4 text-muted-foreground text-sm">没有等你定的事</p>;
  }
  return (
    <ul>
      {props.entries.map((entry) => (
        <NeedsYouRow key={entry.thread.threadId} entry={entry} actions={props.actions} />
      ))}
    </ul>
  );
}

function Title(props: { readonly count: number; readonly children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <h2 className="min-w-0 flex-1 font-medium text-sm">待你定 · {props.count}</h2>
      {props.children}
    </div>
  );
}

/**
 * The popup of a project that also carries a GTD digest (due dates, topic inbox, orphan files): the digest
 * is read when the popup opens, and while it is missing or unavailable the popup is just the pending list.
 */
function PendingWithGtd(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly entries: ReadonlyArray<NeedsYouEntry>;
  readonly actions: Actions;
}) {
  const { environmentId, cwd, entries, actions } = props;
  const { gtd: digest, loading, refresh } = useNeedsYouGtd(environmentId, cwd);
  const [tab, setTab] = useState<GtdTab>("pending");
  const gtd = digest !== null && digest.available ? digest : null;
  const summary = gtd === null ? null : gtdSummary(gtd);
  const tabs: ReadonlyArray<readonly [GtdTab, string]> =
    summary === null
      ? []
      : [
          ["pending", `待定 (${entries.length})`],
          ["wake", `唤醒 (${summary.wake})`],
          ["inbox", `收件·孤儿 (${summary.inbox})`],
        ];
  // The pending list keeps its place in the tree whether or not the digest has arrived, so a reply being typed survives it.
  return (
    <>
      <Title count={entries.length}>
        {gtd === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="刷新"
            disabled={loading}
            onClick={refresh}
          >
            <RefreshIcon refreshing={loading} />
          </Button>
        )}
      </Title>
      {gtd === null ? null : (
        <div
          role="tablist"
          aria-label="待你定分段"
          className="flex items-center gap-1 border-b px-2 py-1.5"
        >
          {tabs.map(([id, label]) => (
            <Button
              key={id}
              role="tab"
              aria-selected={tab === id}
              size="xs"
              variant={tab === id ? "outline" : "ghost-muted"}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      <div
        className={gtd === null ? undefined : "max-h-[min(28rem,60vh)] overflow-y-auto"}
        role={gtd === null ? undefined : "tabpanel"}
      >
        <div hidden={gtd !== null && tab !== "pending"}>
          {gtd !== null && summary !== null && entries.length === 0 && summary.soon > 0 ? (
            <button
              type="button"
              className="w-full border-b bg-muted/40 px-3 py-1.5 text-left text-muted-foreground text-xs hover:text-foreground"
              onClick={() => setTab("wake")}
            >
              有 {summary.soon} 项逾期或 3 天内到期，点此查看唤醒
            </button>
          ) : null}
          <PendingList entries={entries} actions={actions} />
        </div>
        {gtd !== null && tab === "wake" ? (
          <WakeTab gtd={gtd} environmentId={environmentId} cwd={cwd} />
        ) : null}
        {gtd !== null && tab === "inbox" ? (
          <InboxTab gtd={gtd} environmentId={environmentId} cwd={cwd} openThread={actions.open} />
        ) : null}
        {gtd !== null && gtd.errors.length > 0 ? (
          <p className="border-t px-3 py-1.5 text-muted-foreground text-xs">
            部分来源读取失败：{gtd.errors.join("；")}
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * The list a rail button opens, attached to it through `handle`; each row answers its thread in place.
 * With the project's `cwd`, a project that carries a GTD digest also gets the wake and inbox tabs.
 */
export function NeedsYouPopup(props: {
  readonly handle: ReturnType<typeof PopoverCreateHandle>;
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<NeedsYouEntry>;
  readonly cwd?: string | null | undefined;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const actions = useNeedsYouActions(props.environmentId);
  return (
    <Popover handle={props.handle} onOpenChange={props.onOpenChange}>
      <PopoverPopup side="left" align="start" width="lg" padding="none">
        <section
          aria-label="待你定"
          className="w-full"
          // The popup is portaled out of the rail but its events still reach the rail item's drag handler.
          onPointerDown={(event) => event.stopPropagation()}
        >
          {props.cwd === undefined || props.cwd === null ? (
            <>
              <Title count={props.entries.length} />
              <PendingList entries={props.entries} actions={actions} />
            </>
          ) : (
            <PendingWithGtd
              key={props.cwd}
              environmentId={props.environmentId}
              cwd={props.cwd}
              entries={props.entries}
              actions={actions}
            />
          )}
        </section>
      </PopoverPopup>
    </Popover>
  );
}
