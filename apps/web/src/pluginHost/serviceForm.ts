// A form for the flat subset of JSON Schema that MCP elicitation also allows: a top-level object whose
// properties are strings, numbers, integers, booleans or string enums. Anything else is a JSON text box.
type Json = unknown;

interface BaseField {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

export type FormField =
  | (BaseField & { readonly kind: "string"; readonly default?: string })
  | (BaseField & {
      readonly kind: "number" | "integer";
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    })
  | (BaseField & { readonly kind: "boolean"; readonly default: boolean })
  | (BaseField & {
      readonly kind: "enum";
      readonly options: ReadonlyArray<string>;
      readonly default?: string;
    })
  | (BaseField & { readonly kind: "json" });

export type FormShape =
  | { readonly kind: "fields"; readonly fields: ReadonlyArray<FormField> }
  | { readonly kind: "json"; readonly required: boolean };

/** What the user has typed, by field name; the whole-input JSON box uses the key `""`. */
export type FormValues = Readonly<Record<string, string | boolean>>;

const isObject = (value: Json): value is Readonly<Record<string, Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: Json): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function fieldOf(name: string, schema: Json, required: boolean): FormField {
  const base = {
    name,
    required,
    ...(isObject(schema) && typeof schema.description === "string"
      ? { description: schema.description }
      : {}),
  };
  if (!isObject(schema)) return { ...base, kind: "json" };
  const options = schema.enum;
  if (Array.isArray(options)) {
    return options.length > 0 && options.every((option) => typeof option === "string")
      ? {
          ...base,
          kind: "enum",
          options: options as ReadonlyArray<string>,
          ...(typeof schema.default === "string" ? { default: schema.default } : {}),
        }
      : { ...base, kind: "json" };
  }
  switch (schema.type) {
    case "string":
      return {
        ...base,
        kind: "string",
        ...(typeof schema.default === "string" ? { default: schema.default } : {}),
      };
    case "boolean":
      return { ...base, kind: "boolean", default: schema.default === true };
    case "number":
    case "integer": {
      const minimum = finite(schema.minimum);
      const maximum = finite(schema.maximum);
      const fallback = finite(schema.default);
      return {
        ...base,
        kind: schema.type,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(fallback === undefined ? {} : { default: fallback }),
      };
    }
    default:
      return { ...base, kind: "json" };
  }
}

/** The form for an input schema; with no schema there is nothing to fill in. */
export function formShape(schema: Json | undefined): FormShape {
  if (schema === undefined) return { kind: "fields", fields: [] };
  if (!isObject(schema) || (schema.type !== undefined && schema.type !== "object"))
    return { kind: "json", required: true };
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  return {
    kind: "fields",
    fields: Object.entries(properties).map(([name, property]) =>
      fieldOf(name, property, required.has(name)),
    ),
  };
}

export function initialValues(shape: FormShape): FormValues {
  if (shape.kind === "json") return { "": "" };
  return Object.fromEntries(
    shape.fields.flatMap((field): Array<[string, string | boolean]> => {
      switch (field.kind) {
        case "boolean":
          return [[field.name, field.default]];
        case "json":
          return [[field.name, ""]];
        default:
          return [[field.name, field.default === undefined ? "" : String(field.default)]];
      }
    }),
  );
}

/** Why a field cannot be sent; the panel words it. */
export type FieldError =
  | { readonly code: "required" | "not-number" | "not-integer" | "not-json" }
  | { readonly code: "minimum" | "maximum"; readonly limit: number };

export type BuiltInput =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly errors: Readonly<Record<string, FieldError>> };

function parseJson(text: string): { readonly value: Json } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** The call's input from what was typed, or the message for each field that cannot be sent. */
export function buildInput(shape: FormShape, values: FormValues): BuiltInput {
  if (shape.kind === "json") {
    const text = String(values[""] ?? "").trim();
    if (text === "")
      return shape.required
        ? { ok: false, errors: { "": { code: "required" } } }
        : { ok: true, value: null };
    const parsed = parseJson(text);
    return parsed === undefined
      ? { ok: false, errors: { "": { code: "not-json" } } }
      : { ok: true, value: parsed.value };
  }
  const errors: Record<string, FieldError> = {};
  const input: Record<string, Json> = {};
  for (const field of shape.fields) {
    const raw = values[field.name];
    if (field.kind === "boolean") {
      input[field.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (field.required) errors[field.name] = { code: "required" };
      continue;
    }
    switch (field.kind) {
      case "string":
      case "enum":
        input[field.name] = typeof raw === "string" ? raw : text;
        break;
      case "number":
      case "integer": {
        const number = Number(text);
        if (!Number.isFinite(number)) errors[field.name] = { code: "not-number" };
        else if (field.kind === "integer" && !Number.isInteger(number))
          errors[field.name] = { code: "not-integer" };
        else if (field.minimum !== undefined && number < field.minimum)
          errors[field.name] = { code: "minimum", limit: field.minimum };
        else if (field.maximum !== undefined && number > field.maximum)
          errors[field.name] = { code: "maximum", limit: field.maximum };
        else input[field.name] = number;
        break;
      }
      case "json": {
        const parsed = parseJson(text);
        if (parsed === undefined) errors[field.name] = { code: "not-json" };
        else input[field.name] = parsed.value;
        break;
      }
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: input };
}
