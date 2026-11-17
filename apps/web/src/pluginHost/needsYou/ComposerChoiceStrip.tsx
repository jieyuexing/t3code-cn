import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";

import type { ComposerChoice } from "./composerChoices.logic";

/**
 * One button per option of the reply, above the editor of an empty composer. A click fills the
 * composer and sends nothing. While the editor has focus Tab fills the first button and Esc
 * dismisses the strip; the keys are taken before the editor sees them.
 */
export function ComposerChoiceStrip(props: {
  readonly choices: ReadonlyArray<ComposerChoice>;
  readonly onPick: (fill: string) => void;
  readonly onDismiss: () => void;
}) {
  const { choices, onPick, onDismiss } = props;
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
      aria-label="回复里的选项"
      className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5"
    >
      {choices.map((choice) => (
        <Button
          key={choice.fill}
          size="xs"
          variant="outline"
          className="max-w-[220px]"
          title={choice.detail === "" ? undefined : `${choice.fill} ${choice.detail}`}
          // Keeps the editor focused, so the filled text lands where the cursor already is.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onPick(choice.fill)}
        >
          {choice.fill}
          {choice.detail === "" ? null : (
            <span className="min-w-0 truncate font-normal text-muted-foreground">
              {choice.detail}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
}
