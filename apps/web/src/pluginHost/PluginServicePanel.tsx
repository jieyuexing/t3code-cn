import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, PluginId } from "@t3tools/contracts";

import { DiffPanelShell } from "../components/DiffPanelShell";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { PluginSurface } from "../rightPanelStore";
import { PLUGIN_STATUS_VARIANT_BY_KIND, pluginStatus } from "./pluginStatus";
import { ServiceMethodForm } from "./ServiceMethodForm";
import { serviceUi, type UiMethod } from "./serviceMethods";
import {
  pluginHostFailureMessage,
  useCanCallPluginHost,
  usePluginHostCall,
  usePluginHostSnapshot,
} from "./usePluginHost";

/**
 * The tab for one plugin service: its `ui` methods as collapsible forms drawn from their input
 * schemas. The panel stays when the service goes away, with what was typed, and calls work again
 * once the service is back.
 */
export function PluginServicePanel(props: {
  readonly surface: PluginSurface;
  readonly service: string;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly onCloseSurface: () => void;
}) {
  const { surface, service, environmentId, visible, onCloseSurface } = props;
  const navigate = useNavigate();
  const canCall = useCanCallPluginHost(environmentId);
  const { snapshot, failed } = usePluginHostSnapshot(environmentId);
  const run = usePluginHostCall(environmentId);

  if (snapshot === null && !failed) return null;
  if (!canCall) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        This connection cannot use plugin services on this environment.
      </p>
    );
  }
  if (!visible) return null;
  const ui = snapshot === null ? null : serviceUi(snapshot, service, surface.pluginId as PluginId);
  const status = ui === null ? null : pluginStatus(ui.provider);

  const call = async (entry: UiMethod, input: unknown) => {
    const result = await run({
      _tag: "callService",
      service: entry.service,
      method: entry.method.name,
      input: input as never,
    });
    if (result._tag === "Success")
      return { kind: "ok" as const, text: JSON.stringify(result.value.value ?? null, null, 2) };
    return { kind: "error" as const, text: pluginHostFailureMessage(result) };
  };

  return (
    <DiffPanelShell
      mode="embedded"
      header={
        <>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {ui === null ? service : `${ui.provider.name} · ${service}`}
          </span>
          {status === null ? null : (
            <Badge variant={PLUGIN_STATUS_VARIANT_BY_KIND[status.kind]} size="sm">
              {status.label}
            </Badge>
          )}
        </>
      }
    >
      {ui?.available === true ? null : (
        <div className="flex flex-col items-start gap-2 border-b border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
          <p>{`Service ${service} is unavailable. Calls work again once it is back.`}</p>
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
            <Button size="sm" variant="ghost" onClick={onCloseSurface}>
              Close this tab
            </Button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ui === null || ui.methods.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            This service offers no methods to the interface.
          </p>
        ) : (
          ui.methods.map((entry) => (
            <ServiceMethodForm
              key={entry.method.name}
              environmentId={environmentId}
              entry={entry}
              canCall={ui.available}
              call={call}
            />
          ))
        )}
      </div>
    </DiffPanelShell>
  );
}
