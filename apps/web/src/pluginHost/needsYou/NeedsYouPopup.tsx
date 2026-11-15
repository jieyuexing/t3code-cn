import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, type PopoverCreateHandle } from "~/components/ui/popover";

import {
  FOLLOW_RECOMMENDATION,
  KIND_LABELS,
  formatWait,
  type NeedsYouEntry,
  type NeedsYouKind,
} from "./needsYou.logic";
import { useNeedsYouActions } from "./useNeedsYouActions";

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

/** The list a rail button opens, attached to it through `handle`; each row answers its thread in place. */
export function NeedsYouPopup(props: {
  readonly handle: ReturnType<typeof PopoverCreateHandle>;
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<NeedsYouEntry>;
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
          <h2 className="border-b px-3 py-2 font-medium text-sm">
            待你定 · {props.entries.length}
          </h2>
          {props.entries.length === 0 ? (
            <p className="px-3 py-4 text-muted-foreground text-sm">没有等你定的事</p>
          ) : (
            <ul>
              {props.entries.map((entry) => (
                <NeedsYouRow key={entry.thread.threadId} entry={entry} actions={actions} />
              ))}
            </ul>
          )}
        </section>
      </PopoverPopup>
    </Popover>
  );
}
