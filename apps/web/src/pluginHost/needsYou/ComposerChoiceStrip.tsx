import { useGT } from "gt-react";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { isAdvisorItemChoice, isAdvisorMergeChoice } from "./composerChoices.logic";
import { FOLLOW_RECOMMENDATION } from "./needsYou.logic";
import type { ComposerChoicesController } from "./useComposerChoices";

const ADVISOR_BUTTON_CLASS =
  "inline-flex h-7 max-w-[260px] cursor-pointer items-center gap-1 rounded-md border border-dashed border-input bg-popover px-2 text-sm text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:border-solid aria-pressed:border-primary/50 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80 sm:h-6 sm:text-xs";

/**
 * One button per option of the reply, above an empty composer, plus dashed toggle buttons for the
 * context advisor. Advisor buttons support multi-select preview in the composer; rule buttons fill
 * once (按推荐 sends). Tab fills the first button (selecting only the first advisor when applicable)
 * and Esc dismisses the strip, both taken before the editor sees them.
 */
export function ComposerChoiceStrip(props: {
  readonly controller: ComposerChoicesController;
  readonly onPick: (fill: string) => void;
  readonly onSend: (text: string) => void;
}) {
  const { controller, onPick, onSend } = props;
  const {
    choices,
    selectedAdvisorIndices,
    toggleAdvisor,
    toggleAllAdvisors,
    selectFirstAdvisor,
    dismiss,
    resetSelection,
  } = controller;
  const gt = useGT();
  const stripRef = useRef<HTMLDivElement>(null);
  const firstChoice = choices[0];
  const advisorChoices = choices.filter(isAdvisorItemChoice);
  const allAdvisorsSelected =
    advisorChoices.length > 0 && selectedAdvisorIndices.length === advisorChoices.length;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears selection when the strip unmounts after manual edits so backspacing does not reopen it
  useEffect(() => () => resetSelection(), [resetSelection]);

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
      if (event.key === "Tab" && firstChoice !== undefined) {
        onPick(isAdvisorItemChoice(firstChoice) ? selectFirstAdvisor() : firstChoice.fill);
      } else if (event.key === "Escape") {
        dismiss();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [dismiss, firstChoice, onPick, selectFirstAdvisor]);

  return (
    <div
      ref={stripRef}
      data-chat-composer-choices="true"
      role="group"
      aria-label={gt("Reply options")}
      className="flex flex-wrap items-center gap-1.5 px-4 pt-2.5"
    >
      {choices.map((choice) => {
        if (isAdvisorItemChoice(choice)) {
          const advisorIndex = advisorChoices.indexOf(choice);
          const pressed = selectedAdvisorIndices.includes(advisorIndex);
          return (
            <Tooltip key={`advisor:${choice.kind ?? "item"}:${choice.label ?? ""}:${choice.fill}`}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={pressed}
                    className={ADVISOR_BUTTON_CLASS}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onPick(toggleAdvisor(advisorIndex))}
                  />
                }
              >
                <span className="shrink-0 text-muted-foreground">{choice.badge}</span>
                <span className="min-w-0 truncate">{choice.label}</span>
              </TooltipTrigger>
              <TooltipPopup className="whitespace-pre-line">{choice.fill}</TooltipPopup>
            </Tooltip>
          );
        }
        if (isAdvisorMergeChoice(choice)) {
          return (
            <Tooltip key={`advisor-merge:${choice.fill}`}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={allAdvisorsSelected}
                    className={ADVISOR_BUTTON_CLASS}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onPick(toggleAllAdvisors())}
                  />
                }
              >
                <span className="shrink-0 text-muted-foreground">{choice.badge}</span>
                <span className="min-w-0 truncate">{choice.label}</span>
              </TooltipTrigger>
              <TooltipPopup className="whitespace-pre-line">{choice.fill}</TooltipPopup>
            </Tooltip>
          );
        }
        return (
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
        );
      })}
    </div>
  );
}
