import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  railItemKey,
  type PluginHostView,
  type RailBuiltinId,
  type RailItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PlusIcon, SquareMenuIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { PanelLayoutControlsProps } from "~/components/chat/PanelLayoutControls";
import { PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { openPluginView } from "../launcherViews";
import { useThreadPlanProgress } from "../threadPlan/useThreadPlan";
import { RAIL_BUILTIN_LABELS } from "./railBuiltins";
import { RailPinPopover } from "./RailPinPopover";
import { RailWebAppDialog } from "./RailWebAppDialog";
import {
  groupRailItems,
  isRailItemShowing,
  monogram,
  moveItem,
  railPluginState,
  removeItem,
  resolveRailClick,
  togglePin,
  upsertWebApp,
  type PluginAppItem,
  type WebAppItem,
} from "./rail.logic";
import { useRailConfig } from "./useRailConfig";
import { openWebApp, useRailWebContext } from "./webAppTabs";

export interface RailBuiltinAction {
  readonly available: boolean;
  readonly open: () => void;
}

export interface AppRailProps {
  readonly threadRef: ScopedThreadRef;
  /** The same controls the title bar would show; the details card's open state and its popover trigger come from here. */
  readonly controls: PanelLayoutControlsProps;
  /** Shows a tab the thread already has, opening the panel if it was folded. */
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onCollapse: () => void;
  /** How each built-in panel opens a new tab; a panel the thread cannot offer is absent or unavailable. */
  readonly builtins: Readonly<Partial<Record<RailBuiltinId, RailBuiltinAction | undefined>>>;
}

/** Only the panels a global shortcut opens get one in their tooltip. */
const BUILTIN_SHORTCUT_COMMAND = { browser: "preview.toggle", diff: "diff.toggle" } as const;

const itemClassName = (showing: boolean, dimmed: boolean) =>
  cn(
    "relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    showing ? "bg-input/64 text-foreground" : "hover:bg-accent hover:text-foreground",
    dimmed && "opacity-40",
  );

function RailButton(props: {
  readonly label: string;
  readonly shortcut?: string | null | undefined;
  readonly note?: string | undefined;
  readonly showing?: boolean;
  readonly dimmed?: boolean;
  /** A 6px dot on the corner: a plugin that waits or is awaiting consent warns, a quarantined one errs. */
  readonly tone?: "warning" | "error" | undefined;
  readonly pressed?: boolean;
  /** Makes the button the trigger of this popover, which then opens and closes it itself. */
  readonly popoverHandle?: PanelLayoutControlsProps["threadPanelPopoverHandle"];
  readonly onClick: () => void;
  readonly onContextMenu?: (event: React.MouseEvent) => void;
  readonly children: ReactNode;
}) {
  const { label, shortcut, note, showing = false, dimmed = false, pressed } = props;
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-disabled={dimmed || undefined}
      aria-pressed={pressed}
      data-showing={showing || undefined}
      className={itemClassName(showing, dimmed)}
      onClick={dimmed || props.popoverHandle ? undefined : props.onClick}
      onContextMenu={props.onContextMenu}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.popoverHandle ? (
            <PopoverTrigger handle={props.popoverHandle} render={button} />
          ) : (
            button
          )
        }
      >
        {props.children}
        {props.tone ? (
          <span
            className={cn(
              "absolute top-0.75 right-0.75 size-1.5 rounded-full",
              props.tone === "error" ? "bg-error" : "bg-warning",
            )}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="left">
        {label}
        {shortcut ? ` (${shortcut})` : ""}
        {note ? <span className="block text-muted-foreground">{note}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function SortableRailItem(props: { readonly id: string; readonly children: ReactNode }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("flex", isDragging && "z-10 opacity-70")}
      {...listeners}
    >
      {props.children}
    </div>
  );
}

function RailGroup(props: {
  readonly keys: ReadonlyArray<string>;
  readonly editable: boolean;
  readonly onMove: (fromKey: string, toKey: string) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    if (!props.editable || event.over === null || event.active.id === event.over.id) return;
    props.onMove(String(event.active.id), String(event.over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={[...props.keys]} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col items-center gap-1">{props.children}</div>
      </SortableContext>
    </DndContext>
  );
}

const Separator = () => <div role="separator" className="my-1 h-px w-5 shrink-0 bg-border" />;

const AppGlyph = (props: { readonly title: string }) => (
  <span className="flex size-5 items-center justify-center rounded-md border border-current/40 font-semibold text-2xs leading-none">
    {monogram(props.title)}
  </span>
);

type RailDialog = { readonly app: WebAppItem | null };

/**
 * The narrow bar beside the right panel: thread details, the pinned panels, plugin apps and web apps,
 * and a plus that pins more. Its pins live on the server, per environment.
 */
export function AppRail(props: AppRailProps) {
  const { threadRef, builtins, controls } = props;
  const { snapshot, config, canEdit, save } = useRailConfig(threadRef.environmentId);
  const plan = useThreadPlanProgress(threadRef);
  const runningPlan = plan !== null && !plan.complete && !plan.stopped ? plan : null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [dialog, setDialog] = useState<RailDialog | null>(null);

  const groups = groupRailItems(config);
  const webContext = useRailWebContext(
    threadRef,
    config.items.filter((item): item is WebAppItem => item._tag === "web"),
  );
  const hostEnabled = snapshot?.hostEnabled === true;
  const views: ReadonlyArray<PluginHostView> = hostEnabled ? (snapshot?.views ?? []) : [];

  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    });

  const click = (item: RailItem, open: () => void) => {
    const action = resolveRailClick(panel, item, webContext);
    if (action._tag === "collapse") props.onCollapse();
    else if (action._tag === "activate") props.onActivate(action.surface);
    else open();
  };
  const openPlugin = (item: PluginAppItem) => {
    const view = views.find(
      (entry) => entry.pluginId === item.pluginId && entry.viewId === item.viewId,
    );
    if (view !== undefined) openPluginView(threadRef, view);
  };
  const openWeb = (app: WebAppItem) => {
    void openWebApp(threadRef, app, openPreview).catch((error: unknown) =>
      fail("Could not open the web app", error),
    );
  };

  const showMenu = async (event: React.MouseEvent, item: RailItem) => {
    event.preventDefault();
    const api = readLocalApi();
    if (api === undefined || !canEdit) return;
    const web = item._tag === "web";
    const action = await api.contextMenu.show(
      [
        { id: "unpin", label: "Unpin" },
        ...(web ? [{ id: "edit", label: "Edit…" }] : []),
        ...(web ? [{ id: "delete", label: "Delete", destructive: true }] : []),
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (action === "unpin") void save(togglePin(config, item));
    else if (action === "edit" && item._tag === "web") setDialog({ app: item });
    else if (action === "delete") void save(removeItem(config, item));
  };

  const move = (fromKey: string, toKey: string) => void save(moveItem(config, fromKey, toKey));

  const builtinItems = groups.builtin.map((item) => {
    const entry = RAIL_BUILTIN_LABELS[item.id];
    const action = builtins[item.id];
    const command =
      item.id === "browser" || item.id === "diff" ? BUILTIN_SHORTCUT_COMMAND[item.id] : null;
    const Icon = entry.icon;
    const dimmed = action === undefined || !action.available;
    return (
      <SortableRailItem key={railItemKey(item)} id={railItemKey(item)}>
        <RailButton
          label={entry.label}
          shortcut={shortcutLabelForCommand(keybindings, command)}
          note={dimmed ? "Unavailable in this thread" : undefined}
          showing={isRailItemShowing(panel, item, webContext)}
          dimmed={dimmed}
          onClick={() => click(item, () => action?.open())}
          onContextMenu={(event) => void showMenu(event, item)}
        >
          <Icon className="size-4" />
        </RailButton>
      </SortableRailItem>
    );
  });
  const pluginItems = hostEnabled
    ? groups.plugin.map((item) => {
        const state = railPluginState(item, snapshot);
        return (
          <SortableRailItem key={railItemKey(item)} id={railItemKey(item)}>
            <RailButton
              label={item.title}
              note={state.ready ? undefined : state.reason}
              showing={isRailItemShowing(panel, item, webContext)}
              dimmed={!state.ready}
              tone={state.ready ? undefined : state.tone}
              onClick={() => click(item, () => openPlugin(item))}
              onContextMenu={(event) => void showMenu(event, item)}
            >
              <AppGlyph title={item.title} />
            </RailButton>
          </SortableRailItem>
        );
      })
    : [];
  const webItems = groups.web.map((item) => (
    <SortableRailItem key={railItemKey(item)} id={railItemKey(item)}>
      <RailButton
        label={item.title}
        note={item.url}
        showing={isRailItemShowing(panel, item, webContext)}
        onClick={() => click(item, () => openWeb(item))}
        onContextMenu={(event) => void showMenu(event, item)}
      >
        <AppGlyph title={item.title} />
      </RailButton>
    </SortableRailItem>
  ));

  const sections = [
    { key: "builtin", keys: groups.builtin.map(railItemKey), nodes: builtinItems },
    { key: "plugin", keys: groups.plugin.map(railItemKey), nodes: pluginItems },
    { key: "web", keys: groups.web.map(railItemKey), nodes: webItems },
  ].filter((section) => section.nodes.length > 0);

  if (!config.enabled) return null;

  return (
    <nav
      aria-label="App rail"
      data-app-rail
      className="flex w-10 shrink-0 flex-col items-center border-l bg-background [-webkit-app-region:no-drag]"
    >
      <div aria-hidden className="h-(--workspace-topbar-height) w-full shrink-0" />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center scrollbar-gutter-both overflow-y-auto overflow-x-hidden py-1">
        <RailButton
          label="Thread details"
          shortcut={shortcutLabelForCommand(keybindings, "threadPanel.toggle")}
          note={runningPlan ? `Plan ${runningPlan.done}/${runningPlan.total}` : undefined}
          pressed={controls.threadPanelOpen}
          showing={controls.threadPanelOpen}
          popoverHandle={
            controls.threadPanelPresentation === "popover"
              ? controls.threadPanelPopoverHandle
              : undefined
          }
          onClick={controls.onToggleThreadPanel}
        >
          <SquareMenuIcon className="size-4" />
          {runningPlan ? (
            <span className="absolute -right-0.5 -bottom-0.5 rounded-sm bg-primary px-0.5 text-3xs leading-3 font-medium text-primary-foreground tabular-nums">
              {runningPlan.done}/{runningPlan.total}
            </span>
          ) : null}
        </RailButton>
        {sections.map((section) => (
          <div key={section.key} className="flex flex-col items-center">
            <Separator />
            <RailGroup keys={section.keys} editable={canEdit} onMove={move}>
              {section.nodes}
            </RailGroup>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-center pb-2">
        <RailPinPopover
          config={config}
          views={views}
          canEdit={canEdit}
          onChange={(next) => void save(next)}
          onAddWebApp={() => setDialog({ app: null })}
          onEditWebApp={(app) => setDialog({ app })}
        >
          <PlusIcon className="size-4" />
        </RailPinPopover>
      </div>
      {dialog === null ? null : (
        <RailWebAppDialog
          app={dialog.app}
          onClose={() => setDialog(null)}
          onSubmit={(app) => {
            void save(upsertWebApp(config, app));
            setDialog(null);
          }}
        />
      )}
    </nav>
  );
}
