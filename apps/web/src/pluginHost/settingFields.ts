import type { PluginSettingField, PluginSettingValue } from "@t3tools/contracts";

/** The text a field's input shows for a saved value. */
export const settingText = (value: PluginSettingValue | undefined) =>
  value === undefined ? "" : String(value);

/** A number input's text as a finite number, or `null` when it is not one. */
export function parseSettingNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Whether the field stands on its default; an empty text counts, as the plugin falls back to the default for it. */
export function settingIsDefault(field: PluginSettingField, value: PluginSettingValue | undefined) {
  if (field.type === "text" && (value === undefined || value === "")) return true;
  return value === field.default;
}

/** What "Reset to default" names; `null` when there is nothing to reset to. */
export function settingDefaultLabel(field: PluginSettingField): string | null {
  if (field.default === undefined) return null;
  if (field.type === "boolean") return field.default ? "On" : "Off";
  return String(field.default);
}
