import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { ComposerChoice } from "./composerChoices.logic";
import { FOLLOW_RECOMMENDATION } from "./needsYou.logic";

/**
 * One button per option of the reply, above an empty composer, plus dashed ones for the context
 * advisor. Options and advisor buttons only fill the composer; 按推荐 sends. Tab fills the first
 * button and Esc dismisses the strip, both taken before the editor sees them.
 */
export function ComposerChoiceStrip(props: {
  readonly choices: ReadonlyArray<ComposerChoice>;
  readonly onPick: (fill: string) => void;
  readonly onSend: (text: string) => void;
  readonly onDismiss: () => void;
}) {
  const { choices, onPick, onSend, onDismiss } = props;
  const stripRef = useRef<HTMLDivElement>(null);
  const first = choices[0]?.fill;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tab and Esc reach the editor before React, so the strip listens on the document first
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        target.isContentEditable &&
        stripRef.current?.parentElement?.contains(target) === true;
      if (!typing || event.isComposing || event.keyCode === 229) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Tab" && first !== undefined) onPick(first);
      else if (event.key === "Escape") onDismiss();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [first, onPick, onDismiss]);

  return (
    <div
      ref={stripRef}
      data-chat-composer-choices="true"
      role="group"
      // oxlint-disable-next-line t3code/no-untranslated-copy -- the strip is fork-only Chinese copy, outside the catalogs
      aria-label="回复里的选项"
      className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5"
    >
      {choices.map((choice) =>
        choice.source === "advisor" ? (
          <Tooltip key={`advisor:${choice.fill}`}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex h-7 max-w-[260px] cursor-pointer items-center gap-1 rounded-md border border-dashed border-input bg-popover px-2 text-sm text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:h-6 sm:text-xs"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onPick(choice.fill)}
                />
              }
            >
              <span className="shrink-0 text-muted-foreground">{choice.badge}</span>
              <span className="min-w-0 truncate">{choice.label}</span>
            </TooltipTrigger>
            <TooltipPopup>{choice.fill}</TooltipPopup>
          </Tooltip>
        ) : (
          <Button
            key={choice.fill}
            size="xs"
            variant="outline"
            className="max-w-[220px]"
            title={choice.detail === "" ? undefined : `${choice.fill} ${choice.detail}`}
            // Keeps the editor focused, so the filled text lands where the cursor already is.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => (choice.fill === FOLLOW_RECOMMENDATION ? onSend : onPick)(choice.fill)}
          >
            {choice.fill}
            {choice.detail === "" ? null : (
              <span className="min-w-0 truncate font-normal text-muted-foreground">
                {choice.detail}
              </span>
            )}
          </Button>
        ),
      )}
    </div>
  );
}
