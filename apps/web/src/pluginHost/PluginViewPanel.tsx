import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../components/ui/button";
import type { PluginSurface, RightPanelSurface } from "../rightPanelStore";
import { PluginViewFrame } from "./PluginViewFrame";
import { useCanCallPluginHost, usePluginHostSnapshot } from "./usePluginHost";

/**
 * The tab's content. The frame is mounted for the generation the view had when it first appeared;
 * a new generation or a view that left the snapshot unmounts it, and it stays unmounted until the
 * tab is closed and opened again.
 */
export function PluginViewPanel(props: {
  readonly surface: Extract<RightPanelSurface, { kind: "plugin" }>;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
}) {
  const { surface, environmentId, visible, onCloseSurface } = props;
  const navigate = useNavigate();
  const canCall = useCanCallPluginHost(environmentId);
  const { snapshot, failed } = usePluginHostSnapshot(environmentId);
  const [mountedGeneration, setMountedGeneration] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  const view =
    snapshot?.views.find(
      (candidate) => candidate.pluginId === surface.pluginId && candidate.viewId === surface.viewId,
    ) ?? null;
  if (mountedGeneration === null && view !== null) setMountedGeneration(view.generation);

  const settled = snapshot !== null || failed;
  const available = view !== null && view.generation === mountedGeneration;
  if (!settled) return null;
  if (!available) {
    return (
      <div className="flex size-full flex-col items-start justify-center gap-3 px-4 text-sm text-muted-foreground">
        <p>{`Plugin "${surface.title}" is unavailable (disabled or quarantined).`}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({ to: "/settings/plugins", search: { machine: environmentId } })
            }
          >
            Open plugin settings
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onCloseSurface(surface)}>
            Close this tab
          </Button>
        </div>
      </div>
    );
  }
  if (!canCall) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        This connection cannot use plugin views on this environment.
      </p>
    );
  }
  if (!visible) return null;
  return (
    <PluginViewFrame
      key={`${view.generation}:${surface.id}:${reloads}`}
      environmentId={environmentId}
      pluginId={view.pluginId}
      viewId={view.viewId}
      title={view.title}
      generation={view.generation}
      onReload={() => setReloads((value) => value + 1)}
    />
  );
}

export type { PluginSurface };
