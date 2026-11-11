import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../components/ui/button";
import type { PluginSurface, RightPanelSurface } from "../rightPanelStore";
import { PluginServicePanel } from "./PluginServicePanel";
import { PluginViewFrame } from "./PluginViewFrame";
import { serviceOfViewId } from "./serviceMethods";
import { useCanCallPluginHost, usePluginHostSnapshot } from "./usePluginHost";

/**
 * The tab's content: a plugin's own view, or the service panel the host draws for a service
 * (a `viewId` of `service:<name>`). A view that leaves the snapshot unmounts the frame and shows the unavailable
 * state; when it comes back the frame mounts again, a fresh page for a newer generation (the
 * plugin reloaded or was re-enabled), the same page key for a crashed plugin after its backoff.
 */
export function PluginViewPanel(props: {
  readonly surface: Extract<RightPanelSurface, { kind: "plugin" }>;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly threadRef?: ScopedThreadRef;
  /** The thread's checkout: its worktree, or else the project root. */
  readonly files?: { readonly workspaceRoot: string | undefined };
}) {
  const service = serviceOfViewId(props.surface.viewId);
  return service === null ? (
    <PluginViewTab {...props} />
  ) : (
    <PluginServicePanel
      surface={props.surface}
      service={service}
      environmentId={props.environmentId}
      visible={props.visible}
      onCloseSurface={() => props.onCloseSurface(props.surface)}
    />
  );
}

function PluginViewTab(props: {
  readonly surface: Extract<RightPanelSurface, { kind: "plugin" }>;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly threadRef?: ScopedThreadRef;
  /** The thread's checkout: its worktree, or else the project root. */
  readonly files?: { readonly workspaceRoot: string | undefined };
}) {
  const { surface, environmentId, visible, onCloseSurface, threadRef, files } = props;
  const navigate = useNavigate();
  const canCall = useCanCallPluginHost(environmentId);
  const { snapshot, failed } = usePluginHostSnapshot(environmentId);
  const [reloads, setReloads] = useState(0);
  const view =
    snapshot?.views.find(
      (candidate) => candidate.pluginId === surface.pluginId && candidate.viewId === surface.viewId,
    ) ?? null;

  const settled = snapshot !== null || failed;
  if (!settled) return null;
  if (view === null) {
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
      capabilities={
        snapshot?.plugins.find((plugin) => plugin.id === view.pluginId)?.capabilities ?? []
      }
      cwd={files?.workspaceRoot ?? null}
      threadRef={threadRef ?? null}
      onReload={() => setReloads((value) => value + 1)}
    />
  );
}

export type { PluginSurface };
