import { EllipsisIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface RailOverflowRow {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly showing: boolean;
  /** Why the app cannot open now; the row is then greyed out. */
  readonly unavailable?: string | undefined;
  readonly onSelect: () => void;
}

/** The rail's "…": the apps that did not fit, one row each. */
export function RailOverflowPopover(props: { readonly rows: ReadonlyArray<RailOverflowRow> }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="More apps"
                  className={cn(
                    "flex size-8 cursor-pointer items-center justify-center rounded-(--control-radius) text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    open ? "bg-input/64 text-foreground" : "hover:bg-accent hover:text-foreground",
                  )}
                />
              }
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="left">More apps</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="left" align="end" width="md" padding="compact">
        <div className="w-full">
          {props.rows.map((row) => (
            <button
              key={row.key}
              type="button"
              aria-disabled={row.unavailable !== undefined || undefined}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                row.showing ? "bg-input/64" : "hover:bg-accent",
                row.unavailable !== undefined && "opacity-40",
              )}
              onClick={() => {
                if (row.unavailable !== undefined) return;
                setOpen(false);
                row.onSelect();
              }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                {row.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.unavailable === undefined ? null : (
                <span className="shrink-0 text-muted-foreground text-xs">{row.unavailable}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
