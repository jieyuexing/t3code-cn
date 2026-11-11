import type { EnvironmentId, PluginHostEntry, PluginHostSnapshot } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { PluginSettingsForm } from "./PluginSettingsForm";
import {
  clearPluginSettingsReveal,
  pluginSettingsKey,
  setPluginSettingsOpen,
  usePluginSettingsStore,
} from "./pluginSettingsStore";
import { PLUGIN_STATUS_VARIANT_BY_KIND, pluginStatus } from "./pluginStatus";
import { useCanCallPluginHost, usePluginHostAction, usePluginHostSnapshot } from "./usePluginHost";

export function PluginsSettings() {
  const { environment } = useSettingsScope();
  // Pending prompts and drafts belong to one environment, so a scope switch starts fresh.
  return environment === null ? (
    <SettingsPageContainer>
      <SettingsSection title="Plugins">
        <SettingsRow
          title="No environment selected"
          description="Choose an environment to manage its plugins."
        />
      </SettingsSection>
    </SettingsPageContainer>
  ) : (
    <PluginsSettingsBody
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function PluginsSettingsBody(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const { snapshot } = usePluginHostSnapshot(environmentId);
  const canManage = useCanCallPluginHost(environmentId);
  const act = usePluginHostAction(environmentId);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Plugins">
        <SettingsRow
          title="Enable plugins"
          description="Plugins run as your system user on this machine; they are not sandboxed. Turning this off stops every plugin at once."
          status={
            snapshot === null || snapshot.hostEnabled
              ? undefined
              : `${snapshot.registered} registered`
          }
          control={
            <Switch
              checked={snapshot?.hostEnabled ?? false}
              disabled={snapshot === null || !canManage}
              aria-label="Enable plugins"
              onCheckedChange={(enabled) =>
                void act(
                  { _tag: "setHostEnabled", enabled },
                  { title: "Could not change plugin support" },
                )
              }
            />
          }
        />
        {snapshot?.hostEnabled ? (
          <PluginList environmentId={environmentId} snapshot={snapshot} canManage={canManage} />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function PluginList(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: PluginHostSnapshot;
  readonly canManage: boolean;
}) {
  const { environmentId, snapshot, canManage } = props;
  const act = usePluginHostAction(environmentId);
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const result = await act(
      { _tag: "add", path: path.trim() },
      { title: "Could not add the plugin folder" },
    );
    if (result._tag === "Success") {
      setPath("");
      setAdding(false);
    }
  };
  const reloadAll = async () => {
    for (const plugin of snapshot.plugins) {
      await act({ _tag: "reload", pluginId: plugin.id }, { title: "Could not reload the plugin" });
    }
  };

  return (
    <>
      <SettingsRow
        title={`${snapshot.registered} registered`}
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={!canManage}
              onClick={() => setAdding(true)}
            >
              <PlusIcon />
              Add local folder…
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canManage || snapshot.plugins.length === 0}
              onClick={() => void reloadAll()}
            >
              Reload all
            </Button>
          </>
        }
      >
        {adding ? (
          <form
            className="flex items-center gap-2 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (canManage && path.trim() !== "") void add();
            }}
          >
            <Input
              aria-label="Plugin folder path"
              placeholder="/path/to/plugin"
              font="mono"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
            <Button size="xs" type="submit" disabled={!canManage || path.trim() === ""}>
              Add
            </Button>
            <Button size="xs" type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
        ) : null}
      </SettingsRow>
      {snapshot.plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          environmentId={environmentId}
          plugin={plugin}
          snapshot={snapshot}
          canManage={canManage}
        />
      ))}
    </>
  );
}

/** "Waiting for x, y" from the services the plugin lacks; other reasons, such as a dependency cycle, are shown as the host wrote them. */
function waitingText(plugin: PluginHostEntry, reason: string) {
  return reason.startsWith("waiting for ") && plugin.waitingFor.length > 0
    ? `Waiting for ${plugin.waitingFor.join(", ")}`
    : reason;
}

function PluginRow(props: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginHostEntry;
  readonly snapshot: PluginHostSnapshot;
  readonly canManage: boolean;
}) {
  const { environmentId, plugin, snapshot, canManage } = props;
  const act = usePluginHostAction(environmentId);
  const [confirming, setConfirming] = useState(false);
  const settingsKey = pluginSettingsKey(environmentId, plugin.id);
  const settingsOpen = usePluginSettingsStore((state) => state.opened[settingsKey] === true);
  const revealed = usePluginSettingsStore((state) => state.reveal === settingsKey);
  const formRef = useRef<HTMLDivElement>(null);
  const status = pluginStatus(plugin);
  const views = snapshot.views.filter((view) => view.pluginId === plugin.id).length;
  const services = plugin.provides.length;
  const { state } = plugin;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a view asked for this plugin's settings (`t3.openPluginSettings`): bring the row into view once its form is on screen, then take the request
  useEffect(() => {
    if (!revealed) return;
    clearPluginSettingsReveal();
    formRef.current
      ?.closest("[data-slot=settings-row]")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [revealed]);

  const toggle = (enabled: boolean) => {
    if (!enabled)
      return void act(
        { _tag: "disable", pluginId: plugin.id },
        { title: "Could not disable the plugin" },
      );
    if (plugin.consent === "required") return setConfirming(true);
    void act({ _tag: "enable", pluginId: plugin.id }, { title: "Could not enable the plugin" });
  };
  const allow = async () => {
    const result = await act(
      {
        _tag: "enable",
        pluginId: plugin.id,
        grantConsent: true,
      },
      { title: "Could not enable the plugin" },
    );
    if (result._tag === "Success") setConfirming(false);
  };
  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Remove ${plugin.name}?\nIts data files are kept.`,
      { variant: "destructive" },
    );
    if (confirmed === true)
      await act({ _tag: "remove", pluginId: plugin.id }, { title: "Could not remove the plugin" });
  };

  return (
    <SettingsRow
      title={plugin.name}
      description={`${plugin.id}${plugin.version === "" ? "" : ` · ${plugin.version}`}`}
      status={
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={PLUGIN_STATUS_VARIANT_BY_KIND[status.kind]}>{status.label}</Badge>
            <span>{`${views} views · ${services} services${plugin.settings.length === 0 ? "" : ` · ${plugin.settings.length} settings`}${plugin.pid === undefined ? "" : ` · process ${plugin.pid}`}`}</span>
          </div>
          {state._tag === "backoff" ? (
            <p>{`Stopped after ${state.failures} failures. Retrying at ${new Date(state.retryAt).toLocaleTimeString()}. ${state.reason}`}</p>
          ) : null}
          {state._tag === "waiting" ? <p>{waitingText(plugin, state.reason)}</p> : null}
          {state._tag === "quarantined" ? (
            <p>{`Stopped after ${state.failures} failures and no longer restarted. ${state.reason}`}</p>
          ) : null}
          {plugin.problem === undefined ? null : (
            <p className="text-destructive">{plugin.problem}</p>
          )}
          {plugin.rejectedViews.map((view) => (
            <p key={view.viewId} className="text-destructive">
              {`View ${view.viewId} rejected: ${view.reason}`}
            </p>
          ))}
        </div>
      }
      control={
        <>
          {plugin.settings.length === 0 ? null : (
            <Button
              size="xs"
              variant={settingsOpen ? "secondary" : "outline"}
              aria-expanded={settingsOpen}
              onClick={() => setPluginSettingsOpen(settingsKey, !settingsOpen)}
            >
              Settings
            </Button>
          )}
          {state._tag === "backoff" || state._tag === "quarantined" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canManage}
              onClick={() =>
                void act(
                  { _tag: "resume", pluginId: plugin.id },
                  { title: "Could not resume the plugin" },
                )
              }
            >
              Retry
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!canManage}
            onClick={() =>
              void act(
                { _tag: "reload", pluginId: plugin.id },
                { title: "Could not reload the plugin" },
              )
            }
          >
            Reload
          </Button>
          <Button size="xs" variant="outline" disabled={!canManage} onClick={() => void remove()}>
            Remove
          </Button>
          <Switch
            checked={plugin.enabled && plugin.consent === "granted"}
            disabled={!canManage || plugin.problem !== undefined}
            aria-label={`Enable ${plugin.name}`}
            onCheckedChange={toggle}
          />
        </>
      }
    >
      {confirming ? (
        <div className="mb-2 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
          <p>
            <b>{`Allow ${plugin.name} to run?`}</b> It runs as your system user on this machine and
            is not sandboxed. Only enable plugins you trust.
          </p>
          <p className="flex flex-wrap gap-1.5">
            {plugin.capabilities.map((capability) => (
              <Badge key={capability} variant="outline" size="sm">
                {capability}
              </Badge>
            ))}
            <span className="font-mono text-muted-foreground">{plugin.digest.slice(0, 12)}</span>
          </p>
          <div className="flex gap-2">
            <Button size="xs" disabled={!canManage} onClick={() => void allow()}>
              Allow and enable
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {settingsOpen && plugin.settings.length > 0 ? (
        <PluginSettingsForm
          environmentId={environmentId}
          plugin={plugin}
          canManage={canManage}
          formRef={formRef}
          onCollapse={() => setPluginSettingsOpen(settingsKey, false)}
        />
      ) : null}
    </SettingsRow>
  );
}
