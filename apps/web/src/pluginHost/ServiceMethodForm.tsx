import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  buildInput,
  formShape,
  initialValues,
  type FieldError,
  type FormField,
  type FormValues,
} from "./serviceForm";
import { draftOf, methodKey, useServicePanelStore } from "./servicePanelStore";
import type { UiMethod } from "./serviceMethods";

function errorText(error: FieldError) {
  switch (error.code) {
    case "required":
      return "Required";
    case "not-number":
      return "Not a number";
    case "not-integer":
      return "Not a whole number";
    case "not-json":
      return "Not valid JSON";
    case "minimum":
      return `At least ${error.limit}`;
    case "maximum":
      return `At most ${error.limit}`;
  }
}

function FieldRow(props: {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly description: string | undefined;
  readonly error: FieldError | undefined;
  readonly children: React.ReactNode;
}) {
  const { id, label, required, description, error, children } = props;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden className="text-muted-foreground">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error === undefined ? (
        description === undefined ? null : (
          <p className="text-xs text-muted-foreground">{description}</p>
        )
      ) : (
        <p className="text-xs text-destructive">{errorText(error)}</p>
      )}
    </div>
  );
}

function FieldControl(props: {
  readonly id: string;
  readonly field: FormField;
  readonly value: string | boolean;
  readonly invalid: boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  const { id, field, value, invalid, onChange } = props;
  const text = typeof value === "string" ? value : "";
  switch (field.kind) {
    case "boolean":
      return (
        <Switch
          id={id}
          checked={value === true}
          aria-label={field.name}
          onCheckedChange={(checked) => onChange(checked)}
        />
      );
    case "enum":
      return (
        <Select value={text === "" ? null : text} onValueChange={(next) => onChange(next ?? "")}>
          <SelectTrigger id={id} aria-label={field.name} aria-invalid={invalid}>
            <SelectValue>{text === "" ? undefined : text}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "json":
      return (
        <Textarea
          id={id}
          value={text}
          aria-invalid={invalid}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "number":
    case "integer":
      return (
        <Input
          id={id}
          value={text}
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "string":
      return (
        <Input
          id={id}
          value={text}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** The JSON result or error of a call, in the same box a copied command gets. */
function ResultBlock(props: { readonly kind: "ok" | "error"; readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "result" });
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2.5 font-mono text-sm">
      <pre
        className={
          props.kind === "error"
            ? "min-w-0 whitespace-pre-wrap break-words text-destructive"
            : "min-w-0 whitespace-pre-wrap break-words"
        }
        role={props.kind === "error" ? "alert" : "status"}
      >
        {props.text}
      </pre>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy result"
        onClick={() => copyToClipboard(props.text, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/**
 * One method of a service panel: a collapsible form drawn from its input schema, a Call button and the
 * last result. Values and results sit in the panel store, so they survive the panel being unmounted.
 */
export function ServiceMethodForm(props: {
  readonly environmentId: string;
  readonly entry: UiMethod;
  /** False while the service is unavailable: the form keeps its values and cannot call. */
  readonly canCall: boolean;
  readonly call: (
    method: UiMethod,
    input: unknown,
  ) => Promise<{ kind: "ok" | "error"; text: string }>;
}) {
  const { environmentId, entry, canCall, call } = props;
  const { method, service } = entry;
  const key = methodKey(environmentId, service, method.name);
  const shape = formShape(method.input);
  const draft = useServicePanelStore((state) => draftOf(state.drafts, key));
  const focusRequested = useServicePanelStore((state) => state.focusRequest === key);
  const patch = useServicePanelStore((state) => state.patch);
  const clearFocus = useServicePanelStore((state) => state.clearFocus);
  const values: FormValues = draft.values ?? initialValues(shape);
  const pending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into the form a command asked for, once it is on screen
  useEffect(() => {
    if (!focusRequested || !draft.open) return;
    const target = formRef.current?.querySelector<HTMLElement>(
      "input, textarea, button[role=combobox], button[role=switch]",
    );
    if (target === null || target === undefined) return;
    target.focus();
    clearFocus(key);
  }, [focusRequested, draft.open, clearFocus, key]);

  const setValue = (name: string, value: string | boolean) =>
    patch(key, { values: { ...values, [name]: value } });

  const submit = async () => {
    if (!canCall || pending.current) return;
    const built = buildInput(shape, values);
    if (!built.ok) {
      patch(key, { values, errors: built.errors });
      return;
    }
    pending.current = true;
    patch(key, { values, errors: {}, result: null });
    const result = await call(entry, built.value);
    pending.current = false;
    patch(key, { result });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-b border-border/60" data-method={method.name}>
      <Collapsible open={draft.open} onOpenChange={(open) => patch(key, { open })}>
        <CollapsibleTrigger className="flex h-9 w-full items-center gap-2 px-3 text-left text-xs">
          <ChevronRightIcon
            aria-hidden
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${draft.open ? "rotate-90" : ""}`}
          />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {entry.title}
          </span>
          <span className="min-w-0 shrink truncate font-mono text-muted-foreground">
            {method.name}
          </span>
          <Badge variant="outline" size="sm" className="ml-auto">
            {method.readOnly === true ? "Read only" : "Modifies"}
          </Badge>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <form
            ref={formRef}
            className="space-y-3 px-3 pt-1 pb-3"
            onSubmit={onSubmit}
            onKeyDown={onKeyDown}
            noValidate
          >
            {method.description === undefined ? null : (
              <p className="text-xs text-muted-foreground">{method.description}</p>
            )}
            {shape.kind === "json" ? (
              <FieldRow
                id={`${key}|`}
                label="Input (JSON)"
                required={shape.required}
                description={undefined}
                error={draft.errors[""]}
              >
                <FieldControl
                  id={`${key}|`}
                  field={{ kind: "json", name: "", required: shape.required }}
                  value={values[""] ?? ""}
                  invalid={draft.errors[""] !== undefined}
                  onChange={(value) => setValue("", value)}
                />
              </FieldRow>
            ) : (
              shape.fields.map((field) => (
                <FieldRow
                  key={field.name}
                  id={`${key}|${field.name}`}
                  label={field.name}
                  required={field.required}
                  description={field.description}
                  error={draft.errors[field.name]}
                >
                  <FieldControl
                    id={`${key}|${field.name}`}
                    field={field}
                    value={values[field.name] ?? (field.kind === "boolean" ? false : "")}
                    invalid={draft.errors[field.name] !== undefined}
                    onChange={(value) => setValue(field.name, value)}
                  />
                </FieldRow>
              ))
            )}
            <div>
              <Button type="submit" size="xs" disabled={!canCall}>
                Call
              </Button>
            </div>
            {draft.result === null ? null : (
              <ResultBlock kind={draft.result.kind} text={draft.result.text} />
            )}
          </form>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
