import type { PluginSettingField, PluginSettingValue } from "@t3tools/contracts";

const SETTING_VALUE_TYPES = { text: "string", boolean: "boolean", number: "number" } as const;

export const settingProblem = (field: PluginSettingField, value: PluginSettingValue) =>
  typeof value === SETTING_VALUE_TYPES[field.type]
    ? undefined
    : `${field.key} must be a ${field.type}.`;

/** Each field's saved value if it still fits the declaration, else its default. */
export const resolveSettings = (
  fields: ReadonlyArray<PluginSettingField>,
  saved: Readonly<Record<string, PluginSettingValue>>,
) => {
  const values: Record<string, PluginSettingValue> = {};
  for (const field of fields) {
    const candidate = saved[field.key];
    const value =
      candidate !== undefined && settingProblem(field, candidate) === undefined
        ? candidate
        : field.default;
    if (value !== undefined) values[field.key] = value;
  }
  return values;
};
