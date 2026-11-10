import { expect, it } from "vite-plus/test";

import { buildInput, formShape, initialValues } from "./serviceForm";
import { methodNeedsInput } from "./serviceMethods";

const schema = {
  type: "object",
  required: ["name", "times"],
  properties: {
    name: { type: "string", description: "Who." },
    times: { type: "integer", minimum: 1, maximum: 5 },
    ratio: { type: "number", default: 0.5 },
    loud: { type: "boolean" },
    tone: { type: "string", enum: ["friendly", "formal"], default: "friendly" },
    extra: { type: "object", properties: { tags: { type: "array" } } },
  },
};

it("draws the flat subset as fields and anything else as a JSON box", () => {
  const shape = formShape(schema);
  expect(
    shape.kind === "fields" ? shape.fields.map((f) => [f.name, f.kind, f.required]) : null,
  ).toEqual([
    ["name", "string", true],
    ["times", "integer", true],
    ["ratio", "number", false],
    ["loud", "boolean", false],
    ["tone", "enum", false],
    ["extra", "json", false],
  ]);
  expect(formShape({ type: "string" })).toEqual({ kind: "json", required: true });
  expect(formShape(undefined)).toEqual({ kind: "fields", fields: [] });
  const mixedEnum = formShape({ type: "object", properties: { pick: { enum: ["a", 1] } } });
  expect(mixedEnum.kind === "fields" ? mixedEnum.fields[0]?.kind : null).toBe("json");
});

it("starts from the declared defaults and sends only what was filled in", () => {
  const shape = formShape(schema);
  const values = initialValues(shape);
  expect(values).toEqual({
    name: "",
    times: "",
    ratio: "0.5",
    loud: false,
    tone: "friendly",
    extra: "",
  });
  expect(
    buildInput(shape, { ...values, name: "Ada", times: "3", extra: '{"tags":["a"]}' }),
  ).toEqual({
    ok: true,
    value: {
      name: "Ada",
      times: 3,
      ratio: 0.5,
      loud: false,
      tone: "friendly",
      extra: { tags: ["a"] },
    },
  });
});

it("refuses a form with a required field empty or a value outside its type or range", () => {
  const shape = formShape(schema);
  const values = initialValues(shape);
  expect(buildInput(shape, values)).toEqual({
    ok: false,
    errors: { name: { code: "required" }, times: { code: "required" } },
  });
  expect(buildInput(shape, { ...values, name: "Ada", times: "0" })).toEqual({
    ok: false,
    errors: { times: { code: "minimum", limit: 1 } },
  });
  expect(buildInput(shape, { ...values, name: "Ada", times: "9" })).toEqual({
    ok: false,
    errors: { times: { code: "maximum", limit: 5 } },
  });
  expect(buildInput(shape, { ...values, name: "Ada", times: "2.5" })).toEqual({
    ok: false,
    errors: { times: { code: "not-integer" } },
  });
  expect(buildInput(shape, { ...values, name: "Ada", times: "x" })).toEqual({
    ok: false,
    errors: { times: { code: "not-number" } },
  });
  expect(buildInput(shape, { ...values, name: "Ada", times: "2", extra: "{" })).toEqual({
    ok: false,
    errors: { extra: { code: "not-json" } },
  });
});

it("reads a whole input that is not an object from one JSON box", () => {
  const shape = formShape({ type: "array" });
  expect(buildInput(shape, { "": "" })).toEqual({
    ok: false,
    errors: { "": { code: "required" } },
  });
  expect(buildInput(shape, { "": "[1,2]" })).toEqual({ ok: true, value: [1, 2] });
});

it("needs input only for a non-object schema or required fields", () => {
  const method = (input?: unknown) =>
    ({ name: "m", ...(input === undefined ? {} : { input }) }) as never;
  expect(methodNeedsInput(method())).toBe(false);
  expect(methodNeedsInput(method({ type: "object", properties: { a: { type: "string" } } }))).toBe(
    false,
  );
  expect(methodNeedsInput(method(schema))).toBe(true);
  expect(methodNeedsInput(method({ type: "string" }))).toBe(true);
});
