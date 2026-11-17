import {
  RAIL_BUILTIN_IDS,
  railItemKey,
  type PluginHostView,
  type RailConfig,
  type RailItem,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, PuzzleIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { RAIL_BUILTIN_LABELS } from "./railBuiltins";
import { isPinned, removeItem, togglePin, type WebAppItem } from "./rail.logic";
import { railIconOf } from "./railIcons";

function PinRow(props: {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-(--control-radius) px-2 hover:bg-accent/60">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
        <Checkbox
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={props.onToggle}
        />
        {props.icon}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
      </label>
      {props.actions}
    </div>
  );
}

const pluginIcon = (views: ReadonlyArray<PluginHostView>, item: RailItem) => {
  const view =
    item._tag === "plugin"
      ? views.find(
          (candidate) => candidate.pluginId === item.pluginId && candidate.viewId === item.viewId,
        )
      : undefined;
  const className = "size-4 text-muted-foreground";
  return railIconOf(view?.icon, className) ?? <PuzzleIcon className={className} />;
};

const SectionTitle = (props: { readonly children: ReactNode }) => (
  <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">{props.children}</div>
);

/** The rail's plus: tick what to pin, and add or edit web apps. */
export function RailPinPopover(props: {
  readonly config: RailConfig;
  /** The plugin apps the environment offers right now; empty while plugins are off. */
  readonly views: ReadonlyArray<PluginHostView>;
  readonly canEdit: boolean;
  readonly onChange: (next: RailConfig) => void;
  readonly onAddWebApp: () => void;
  readonly onEditWebApp: (app: WebAppItem) => void;
  readonly children: ReactNode;
}) {
  const { config, canEdit, onChange } = props;
  const pluginItems: ReadonlyArray<RailItem> = [
    ...props.views.map((view): RailItem => ({
      _tag: "plugin",
      pluginId: view.pluginId,
      viewId: view.viewId,
      title: view.title,
    })),
    ...config.items.filter(
      (item) =>
        item._tag === "plugin" &&
        props.views.length > 0 &&
        !props.views.some((view) => view.pluginId === item.pluginId && view.viewId === item.viewId),
    ),
  ];
  const webApps = config.items.filter((item): item is WebAppItem => item._tag === "web");

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Add apps"
                  className="flex size-8 cursor-pointer items-center justify-center rounded-(--control-radius) text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            />
          }
        >
          {props.children}
        </TooltipTrigger>
        <TooltipPopup side="left">Add apps</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="left" align="end" width="md" padding="compact">
        <div className="w-full">
          <SectionTitle>Panels</SectionTitle>
          {RAIL_BUILTIN_IDS.map((id) => {
            const item: RailItem = { _tag: "builtin", id };
            const { label, icon: Icon } = RAIL_BUILTIN_LABELS[id];
            return (
              <PinRow
                key={id}
                label={label}
                icon={<Icon className="size-4 text-muted-foreground" />}
                checked={isPinned(config, item)}
                disabled={!canEdit}
                onToggle={() => onChange(togglePin(config, item))}
              />
            );
          })}
          {pluginItems.length === 0 ? null : (
            <>
              <SectionTitle>Plugin apps</SectionTitle>
              {pluginItems.map((item) => (
                <PinRow
                  key={railItemKey(item)}
                  label={item._tag === "plugin" ? item.title : ""}
                  icon={pluginIcon(props.views, item)}
                  checked={isPinned(config, item)}
                  disabled={!canEdit}
                  onToggle={() => onChange(togglePin(config, item))}
                />
              ))}
            </>
          )}
          <SectionTitle>Web apps</SectionTitle>
          {webApps.map((app) => (
            <PinRow
              key={app.id}
              label={app.title}
              checked={isPinned(config, app)}
              disabled={!canEdit}
              onToggle={() => onChange(togglePin(config, app))}
              actions={
                <>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Edit ${app.title}`}
                    disabled={!canEdit}
                    onClick={() => props.onEditWebApp(app)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Delete ${app.title}`}
                    disabled={!canEdit}
                    onClick={() => onChange(removeItem(config, app))}
                  >
                    <Trash2Icon />
                  </Button>
                </>
              }
            />
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 w-full justify-start"
            disabled={!canEdit}
            onClick={props.onAddWebApp}
          >
            <PlusIcon />
            Add web app…
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
