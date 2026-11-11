import type {
  EnvironmentId,
  PluginHostEntry,
  PluginSettingField,
  PluginSettingValue,
} from "@t3tools/contracts";
import { useRef, useState, type Ref } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  parseSettingNumber,
  settingDefaultLabel,
  settingIsDefault,
  settingText,
} from "./settingFields";
import { pluginHostFailureMessage, usePluginHostCall } from "./usePluginHost";

const SAVED_SHOWN_MS = 2000;

/** The settings a plugin declares, as a form that saves each field as it is edited. */
export const PluginSettingsForm = (props: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginHostEntry;
  readonly canManage: boolean;
  readonly onCollapse: () => void;
  readonly formRef?: Ref<HTMLDivElement>;
}) => {
  const { environmentId, plugin, canManage, onCollapse, formRef } = props;
  return (
    <div
      ref={formRef}
      data-slot="plugin-settings"
      className="mb-2 rounded-lg border border-border bg-card px-4 pb-3"
    >
      {plugin.settings.map((field) => (
        <SettingField
          key={field.key}
          environmentId={environmentId}
          plugin={plugin}
          field={field}
          canManage={canManage}
        />
      ))}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs text-muted-foreground">
        <span>
          Press Enter or leave a field to save it. The plugin uses the new value on its next call;
          no reload needed.
        </span>
        <Button size="xs" variant="ghost" onClick={onCollapse}>
          Collapse
        </Button>
      </div>
    </div>
  );
};

function SettingField(props: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginHostEntry;
  readonly field: PluginSettingField;
  readonly canManage: boolean;
}) {
  const { environmentId, plugin, field, canManage } = props;
  const call = usePluginHostCall(environmentId);
  const value = plugin.settingValues[field.key];
  // What was typed and not saved yet; `null` follows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = async (next: PluginSettingValue) => {
    const result = await call({
      _tag: "setSetting",
      pluginId: plugin.id,
      key: field.key,
      value: next,
    });
    if (result._tag !== "Success") {
      setSaved(false);
      setError(pluginHostFailureMessage(result));
      return;
    }
    setDraft(null);
    setError(null);
    setSaved(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), SAVED_SHOWN_MS);
  };

  const commit = () => {
    if (draft === null) return;
    if (field.type === "number") {
      const number = parseSettingNumber(draft);
      if (number === null) return setError("Enter a number");
      if (number !== value) return void save(number);
    } else if (draft !== settingText(value)) {
      return void save(draft);
    }
    setDraft(null);
    setError(null);
  };
  const edit = (text: string) => {
    setDraft(text);
    setError(null);
    setSaved(false);
  };

  const defaultLabel = settingDefaultLabel(field);
  const unsaved = draft !== null && draft !== settingText(value);
  const reset =
    defaultLabel === null ||
    field.default === undefined ||
    settingIsDefault(field, value) ? null : (
      <Button
        size="xs"
        variant="ghost"
        disabled={!canManage}
        onClick={() => void save(field.default as PluginSettingValue)}
      >
        {`Reset to default (${defaultLabel})`}
      </Button>
    );

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-border py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,17.5rem)]">
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {field.label}
          <span className="ms-1.5 font-mono text-2xs font-normal text-muted-foreground">
            {field.key}
          </span>
        </div>
        {field.description === undefined ? null : (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {field.type === "boolean" ? (
          <div className="flex justify-end">
            <Switch
              checked={value === true}
              disabled={!canManage}
              aria-label={field.label}
              onCheckedChange={(checked) => void save(checked)}
            />
          </div>
        ) : (
          <Input
            aria-label={field.label}
            aria-invalid={error === null ? undefined : true}
            font="mono"
            size="compact"
            disabled={!canManage}
            placeholder={field.default === undefined ? undefined : String(field.default)}
            value={draft ?? settingText(value)}
            onChange={(event) => edit(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        )}
        <div className="flex min-h-4 items-center justify-between gap-2 text-2xs text-muted-foreground">
          {error !== null ? (
            <span className="text-destructive">{error}</span>
          ) : saved ? (
            <span className="text-success">Saved</span>
          ) : unsaved ? (
            <span>Unsaved</span>
          ) : settingIsDefault(field, value) ? (
            <span>Default</span>
          ) : (
            <span />
          )}
          {reset}
        </div>
      </div>
    </div>
  );
}
