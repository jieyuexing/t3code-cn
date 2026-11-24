import { useMessages } from "gt-react";
import { WandIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isMacPlatform } from "~/lib/utils";

import { PROMPT_REFINE_MODE_META, PROMPT_REFINER_COPY } from "./promptRefiner.logic";
import type { usePromptRefiner } from "./usePromptRefiner";

export type PromptRefiner = ReturnType<typeof usePromptRefiner>;

/** The wand beside the attach button, plus Undo until the next edit after a replacement. */
export function PromptRefinerButton(props: { readonly refiner: PromptRefiner }) {
  const { refiner } = props;
  const resolve = useMessages();
  const shortcut = isMacPlatform(navigator.platform) ? "⌘⇧Y" : "Ctrl+Shift+Y";
  const tooltip = PROMPT_REFINER_COPY.tooltip(shortcut, resolve);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!refiner.canStart}
              aria-label={tooltip}
              // Keeps the editor focused, so the selection the refiner reads is still there.
              onPointerDown={(event) => event.preventDefault()}
              onClick={refiner.start}
            />
          }
        >
          <WandIcon />
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
      {refiner.undoAvailable ? (
        <Button
          type="button"
          variant="ghost-muted"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={refiner.undo}
        >
          {resolve(PROMPT_REFINER_COPY.undo)}
        </Button>
      ) : null}
    </>
  );
}

/** The answer above the composer text: mode capsules, the refined draft, and replace or cancel. */
export function PromptRefinerCard(props: {
  readonly refiner: PromptRefiner;
  /** The composer's text right now, to tell a late answer from a fresh one. */
  readonly prompt: string;
}) {
  const { refiner, prompt } = props;
  const resolve = useMessages();
  const { state } = refiner;
  if (state.status === "idle") return null;
  const draftChanged = prompt !== state.snapshot.draft;
  return (
    <div
      data-prompt-refiner-card="true"
      role="region"
      aria-label={resolve(PROMPT_REFINER_COPY.region)}
      className="mx-3 mt-2 flex flex-col gap-2 rounded-xl border border-primary/40 bg-card p-2.5"
    >
      <div className="flex flex-wrap items-center gap-1">
        {PROMPT_REFINE_MODE_META.map((entry) => (
          <Button
            key={entry.mode}
            type="button"
            size="xs"
            variant={entry.mode === state.mode ? "secondary" : "ghost-muted"}
            aria-pressed={entry.mode === state.mode}
            title={resolve(entry.hint)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => refiner.selectMode(entry.mode)}
          >
            {resolve(entry.label)}
          </Button>
        ))}
        {state.status === "preview" && state.result.usedWorkspaceContext ? (
          <span className="ms-auto text-xs text-muted-foreground">
            {resolve(PROMPT_REFINER_COPY.withContext)}
          </span>
        ) : null}
        {state.status === "preview" && draftChanged ? (
          <span className="ms-auto text-xs text-warning-foreground">
            {resolve(PROMPT_REFINER_COPY.draftChanged)}
          </span>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {resolve(PROMPT_REFINER_COPY.loading)}
        </div>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="px-1 py-1 text-sm text-destructive-foreground">
          {state.message}
        </p>
      ) : null}
      {state.status === "preview" ? (
        <div
          data-testid="prompt-refiner-result"
          className="max-h-56 overflow-y-auto rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap"
        >
          {state.result.refined}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        {state.status === "error" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => refiner.selectMode(state.mode)}
          >
            {resolve(PROMPT_REFINER_COPY.retry)}
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="ghost-muted" onClick={refiner.cancel}>
          {resolve(PROMPT_REFINER_COPY.cancel)}
        </Button>
        {state.status === "preview" ? (
          <Button type="button" size="xs" onClick={refiner.apply}>
            {resolve(PROMPT_REFINER_COPY.apply)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
