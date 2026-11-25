import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { type ReactNode, useState } from "react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { RefreshIcon } from "../../../components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { SettingsRow, SettingsSection } from "../../../components/settings/settingsLayout";
import {
  ADVISOR_TEST_SCENARIOS,
  type AdvisorTestScenario,
  choicesWith,
  describeRan,
  describeRoleStatus,
  describeSlotSharing,
  fromSelectValue,
  type LensKey,
  MAX_APPENDIX_CHARS,
  MAX_PROMPT_CHARS,
  type PromptAdvisorConfig,
  type PromptAdvisorPayload,
  type PromptAdvisorTestRequest,
  REFINE_MODES,
  type RefineModeKey,
  type RoleStatus,
  type RuntimeRole,
  toSelectValue,
  withAdvisorText,
  withFollow,
  withLens,
  withModeOverride,
  withRuntime,
} from "./promptAdvisorConfig.logic";
import { type TestState, usePromptAdvisorSettings } from "./usePromptAdvisorSettings";

/** Saves when the box loses focus, so typing never round-trips to the server. */
function DraftTextarea(props: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly label: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  readonly disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      aria-label={props.label}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      disabled={props.disabled}
      rows={5}
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft ?? props.value;
        setDraft(null);
        if (next !== props.value) props.onCommit(next);
      }}
    />
  );
}

function Disclosure(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
        {props.title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-2 pt-2">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function PromptPreview(props: { readonly text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
      {props.text}
    </pre>
  );
}

function RolePicker(props: {
  readonly label: string;
  readonly value: string | null;
  readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly autoLabel: string;
  readonly disabled: boolean;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = props.choices.find((choice) => choice.value === props.value);
  return (
    <Select
      value={toSelectValue(props.value)}
      onValueChange={(next) => {
        if (typeof next === "string") props.onChange(fromSelectValue(next));
      }}
      disabled={props.disabled}
    >
      <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={props.label}>
        <SelectValue>{selected?.label ?? props.autoLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={toSelectValue(null)}>
          {props.autoLabel}
        </SelectItem>
        {props.choices.map((choice) => (
          <SelectItem hideIndicator key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function RuntimeRow(props: {
  readonly role: RuntimeRole;
  readonly payload: PromptAdvisorPayload;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onChange: (config: PromptAdvisorConfig) => void;
}) {
  const gt = useGT();
  const { config, status } = props.payload;
  const runtime = props.role === "advisor" ? config.advisor.runtime : config.refiner.runtime;
  const roleStatus = status[props.role];
  const auto = gt("Auto");
  const apply = (patch: Partial<typeof runtime>) =>
    props.onChange(withRuntime(config, props.role, patch));
  const named = (values: ReadonlyArray<string>) => values.map((value) => ({ value, label: value }));
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RolePicker
            label={gt("Instance", { $context: "provider instance picker" })}
            value={runtime.instanceId}
            autoLabel={auto}
            disabled={props.disabled}
            choices={choicesWith(
              status.instances.map(({ instanceId }) => instanceId),
              runtime.instanceId,
            ).map((instanceId) => ({
              value: instanceId,
              label: status.instances.some(
                (entry) => entry.instanceId === instanceId && !entry.available,
              )
                ? gt("{instance} (unavailable)", { instance: instanceId })
                : instanceId,
            }))}
            onChange={(instanceId) => apply({ instanceId })}
          />
          <RolePicker
            label={gt("Model")}
            value={runtime.model}
            autoLabel={auto}
            disabled={props.disabled}
            choices={named(choicesWith(roleStatus.availableModels, runtime.model))}
            onChange={(model) => apply({ model })}
          />
          <RolePicker
            label={gt("Thinking level")}
            value={runtime.thinking}
            autoLabel={auto}
            disabled={props.disabled}
            choices={named(choicesWith(roleStatus.availableThinking, runtime.thinking))}
            onChange={(thinking) => apply({ thinking })}
          />
        </div>
      }
    />
  );
}

function StatusRow(props: {
  readonly title: string;
  readonly status: RoleStatus;
  readonly extra?: string;
  readonly onRefresh: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  return (
    <SettingsRow
      title={props.title}
      description={
        <>
          <span>{describeRoleStatus(props.status, resolve)}</span>
          {props.extra === undefined ? null : <span className="block">{props.extra}</span>}
          {props.status.lastError === null ? null : (
            <span className="block text-destructive">{props.status.lastError}</span>
          )}
        </>
      }
      control={
        <Button
          size="xs"
          variant="outline"
          aria-label={gt("Refresh status")}
          onClick={props.onRefresh}
        >
          <RefreshIcon />
        </Button>
      }
    />
  );
}

function TestOutcome(props: { readonly state: TestState; readonly role: RuntimeRole }) {
  const gt = useGT();
  const resolve = useMessages();
  const { state } = props;
  if (state.phase === "idle") return null;
  if (state.phase === "running") {
    return <p className="text-xs text-muted-foreground">{gt("Running the sample…")}</p>;
  }
  if (state.phase === "failed") return <p className="text-xs text-destructive">{state.message}</p>;
  const { result } = state;
  const kindLabel = {
    challenge: gt("Challenge", { $context: "prompt advisor suggestion type" }),
    next: gt("Next", { $context: "prompt advisor suggestion type" }),
    angle: gt("Angle", { $context: "prompt advisor suggestion type" }),
  } as const;
  return (
    <div className="space-y-2 text-xs" data-testid={`prompt-advisor-test-${props.role}`}>
      {result.refined === undefined ? null : (
        <p className="rounded-md border border-border bg-muted/40 p-2 whitespace-pre-wrap text-foreground">
          {result.refined}
        </p>
      )}
      {result.items === undefined ? null : result.items.length === 0 ? (
        <p className="text-muted-foreground">
          {(result.dropped ?? 0) > 0
            ? gt(
                "{count, plural, one {The advisor returned {count} suggestion, but it was removed by the app's safety rules (too long, empty agreement or duplicate).} other {The advisor returned {count} suggestions, but all were removed by the app's safety rules (too long, empty agreement or duplicates).}}",
                { count: result.dropped },
              )
            : gt("The advisor found nothing worth saying for this sample.")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {result.items.map((item) => (
            <li key={`${item.kind}:${item.fill}`} className="flex items-start gap-2">
              <Badge variant="outline" className="shrink-0">
                {kindLabel[item.kind]}
              </Badge>
              <span>
                <span className="font-medium text-foreground">{item.label}</span>
                <span className="block text-muted-foreground">{item.fill}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.items !== undefined && result.items.length > 0 && (result.dropped ?? 0) > 0 ? (
        <p className="text-muted-foreground">
          {gt(
            "{count, plural, one {{count} more suggestion was removed by the app's safety rules.} other {{count} more suggestions were removed by the app's safety rules.}}",
            {
              count: result.dropped,
            },
          )}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {result.draft ? `${gt("Ran on your unsaved draft.")} · ` : ""}
        {describeRan(result.ran, resolve)}
        {" · "}
        {gt("took {time}s", { time: (result.durationMs / 1000).toFixed(1) })}
      </p>
    </div>
  );
}

function AdvisorBlock(props: {
  readonly payload: PromptAdvisorPayload;
  readonly disabled: boolean;
  readonly test: TestState;
  readonly dirty: boolean;
  readonly onEdit: (config: PromptAdvisorConfig) => void;
  readonly onRefresh: () => void;
  readonly onTest: (scenario: AdvisorTestScenario) => void;
}) {
  const gt = useGT();
  const { config, status, previews, defaults } = props.payload;
  const [scenario, setScenario] = useState<AdvisorTestScenario>("vague");
  const lenses: ReadonlyArray<{
    readonly key: LensKey;
    readonly title: string;
    readonly description: string;
  }> = [
    {
      key: "grilling",
      title: gt("Decision frontier and subtraction (grilling + keel)"),
      description: gt(
        "While a plan is being settled: ask the one question that changes the outcome, and what can be cut.",
      ),
    },
    {
      key: "debugging",
      title: gt("Systematic debugging (systematic-debugging)"),
      description: gt(
        "While a bug is being fixed: reproduce and find the root cause before patching.",
      ),
    },
    {
      key: "blastRadius",
      title: gt("Downstream impact proof (blast-radius)"),
      description: gt("After a change: what breaks outside the diff, proven with real code."),
    },
  ];
  const scenarioLabel: Record<AdvisorTestScenario, string> = {
    vague: gt("Vague request"),
    debugging: gt("Debugging", { $context: "advisor sample scenario" }),
    explicit_choices: gt("Options offered"),
  };
  const customized =
    config.advisor.customAppendix !== "" ||
    config.advisor.promptOverride !== "" ||
    ADVISOR_LENS_KEYS.some((key) => config.advisor.lenses[key] !== defaults.advisor.lenses[key]);
  return (
    <SettingsSection title={gt("Context advisor (every turn)")}>
      <StatusRow title={gt("Live status")} status={status.advisor} onRefresh={props.onRefresh} />
      <RuntimeRow
        role="advisor"
        payload={props.payload}
        title={gt("Instance, model and thinking level")}
        description={gt("Runs after every turn, so a fast, light model is usually enough.")}
        disabled={props.disabled}
        onChange={props.onEdit}
      />
      {lenses.map((lens) => (
        <SettingsRow
          key={lens.key}
          title={lens.title}
          description={lens.description}
          control={
            <Switch
              checked={config.advisor.lenses[lens.key]}
              disabled={props.disabled}
              aria-label={lens.title}
              onCheckedChange={(enabled) => props.onEdit(withLens(config, lens.key, enabled))}
            />
          }
        />
      ))}
      <SettingsRow
        title={gt("Prompt")}
        description={gt(
          "Extra instructions are added after the built-in ones. Edits are kept as a draft until you save.",
        )}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled || !customized}
            onClick={() =>
              props.onEdit({
                ...config,
                advisor: {
                  ...config.advisor,
                  lenses: defaults.advisor.lenses,
                  customAppendix: defaults.advisor.customAppendix,
                  promptOverride: defaults.advisor.promptOverride,
                },
              })
            }
          >
            {gt("Restore default")}
          </Button>
        }
      >
        <div className="space-y-3 pb-2">
          <DraftTextarea
            label={gt("Extra instructions")}
            placeholder={gt("Extra instructions (appended)")}
            value={config.advisor.customAppendix}
            maxLength={MAX_APPENDIX_CHARS}
            disabled={props.disabled}
            onCommit={(text) => props.onEdit(withAdvisorText(config, "customAppendix", text))}
          />
          <Disclosure title={gt("Replace the whole prompt")}>
            <p className="text-xs text-muted-foreground">
              {gt(
                "Replaces the built-in thinking instructions, so the three lenses no longer apply. You do not write any JSON: the output format, length limits and conversation delimiters are fixed by the app.",
              )}
            </p>
            <DraftTextarea
              label={gt("Replacement prompt")}
              placeholder={previews.advisorBuiltInInstructions}
              value={config.advisor.promptOverride}
              maxLength={MAX_PROMPT_CHARS}
              disabled={props.disabled}
              onCommit={(text) => props.onEdit(withAdvisorText(config, "promptOverride", text))}
            />
          </Disclosure>
          <Disclosure title={gt("Show the full prompt in effect")}>
            <PromptPreview text={previews.advisorPromptPreview} />
            <p className="text-xs text-muted-foreground">
              {gt("When the latest reply already lists options:")}
            </p>
            <PromptPreview text={previews.advisorExplicitPromptPreview} />
          </Disclosure>
        </div>
      </SettingsRow>
      <SettingsRow
        title={gt("Try it with a sample conversation")}
        description={
          props.dirty
            ? gt("Runs once on your unsaved edits, so you can judge them before saving.")
            : gt("Runs once with the saved settings; no need to wait for a chat turn.")
        }
        control={
          <div className="flex items-center gap-2">
            <Select
              value={scenario}
              onValueChange={(next) => {
                if (ADVISOR_TEST_SCENARIOS.some((entry) => entry === next)) {
                  setScenario(next as AdvisorTestScenario);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-32 shrink-0"
                aria-label={gt("Sample", { $context: "example conversation picker" })}
              >
                <SelectValue>{scenarioLabel[scenario]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {ADVISOR_TEST_SCENARIOS.map((entry) => (
                  <SelectItem hideIndicator key={entry} value={entry}>
                    {scenarioLabel[entry]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled || props.test.phase === "running"}
              onClick={() => props.onTest(scenario)}
            >
              {gt("Try sample")}
            </Button>
          </div>
        }
      >
        <div className="pb-2">
          <TestOutcome state={props.test} role="advisor" />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

const ADVISOR_LENS_KEYS: ReadonlyArray<LensKey> = ["grilling", "debugging", "blastRadius"];

function RefinerBlock(props: {
  readonly payload: PromptAdvisorPayload;
  readonly disabled: boolean;
  readonly test: TestState;
  readonly dirty: boolean;
  readonly onEdit: (config: PromptAdvisorConfig) => void;
  readonly onRefresh: () => void;
  readonly onTest: (mode: RefineModeKey) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { config, status, previews } = props.payload;
  const [mode, setMode] = useState<RefineModeKey>("structured");
  const modeLabel: Record<RefineModeKey, string> = {
    structured: gt("Structured", { $context: "prompt refine mode" }),
    bold: gt("Divergent", { $context: "prompt refine mode" }),
    scoped: gt("Scoped", { $context: "prompt refine mode" }),
  };
  return (
    <SettingsSection title={gt("Prompt refiner (on demand)")}>
      <StatusRow
        title={gt("Live status")}
        status={status.refiner}
        extra={describeSlotSharing(status.refiner, resolve)}
        onRefresh={props.onRefresh}
      />
      <SettingsRow
        title={gt("Follow the context advisor's model settings")}
        description={gt("Shares the advisor's warm process, so nothing extra is started.")}
        control={
          <Switch
            checked={config.refiner.followAdvisorRuntime}
            disabled={props.disabled}
            aria-label={gt("Follow the context advisor's model settings")}
            onCheckedChange={(follow) => props.onEdit(withFollow(config, follow))}
          />
        }
      />
      {config.refiner.followAdvisorRuntime ? null : (
        <RuntimeRow
          role="refiner"
          payload={props.payload}
          title={gt("Instance, model and thinking level")}
          description={gt(
            "Starts its own warm process on demand. Changing this does not affect the context advisor.",
          )}
          disabled={props.disabled}
          onChange={props.onEdit}
        />
      )}
      {REFINE_MODES.map((entry) => {
        const builtIn = previews.refinerBuiltInDirectives[entry];
        const override = config.refiner.modeOverrides[entry];
        return (
          <SettingsRow
            key={entry}
            title={modeLabel[entry]}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={props.disabled || override === ""}
                aria-label={gt("Restore default for {mode}", { mode: modeLabel[entry] })}
                onClick={() => props.onEdit(withModeOverride(config, entry, ""))}
              >
                {gt("Restore default")}
              </Button>
            }
          >
            <div className="pb-2">
              <Disclosure title={gt("View and edit this mode's prompt")}>
                <DraftTextarea
                  label={gt("Prompt for {mode}", { mode: modeLabel[entry] })}
                  value={override === "" ? builtIn : override}
                  maxLength={MAX_PROMPT_CHARS}
                  disabled={props.disabled}
                  onCommit={(text) =>
                    props.onEdit(
                      withModeOverride(config, entry, text.trim() === builtIn.trim() ? "" : text),
                    )
                  }
                />
                <Disclosure title={gt("Show the full prompt in effect")}>
                  <PromptPreview text={previews.refinerModePreviews[entry]} />
                </Disclosure>
              </Disclosure>
            </div>
          </SettingsRow>
        );
      })}
      <SettingsRow
        title={gt("Try it with a sample draft")}
        description={
          props.dirty
            ? gt("Rewrites a built-in sample draft on your unsaved edits.")
            : gt("Rewrites a built-in sample draft with the saved settings.")
        }
        control={
          <div className="flex items-center gap-2">
            <Select
              value={mode}
              onValueChange={(next) => {
                if (REFINE_MODES.some((entry) => entry === next)) setMode(next as RefineModeKey);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-32 shrink-0"
                aria-label={gt("Mode", { $context: "prompt refine mode picker" })}
              >
                <SelectValue>{modeLabel[mode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {REFINE_MODES.map((entry) => (
                  <SelectItem hideIndicator key={entry} value={entry}>
                    {modeLabel[entry]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled || props.test.phase === "running"}
              aria-label={gt("Try sample draft")}
              onClick={() => props.onTest(mode)}
            >
              {gt("Try sample")}
            </Button>
          </div>
        }
      >
        <div className="pb-2">
          <TestOutcome state={props.test} role="refiner" />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * The context advisor and prompt refiner settings, kept free of the host settings panels and
 * contracts so the whole block can move into a plugin page unchanged.
 */
export function PromptAdvisorSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const settings = usePromptAdvisorSettings(props.environmentId);
  const { payload, config } = settings;
  if (payload === null || config === null) {
    return (
      <SettingsSection title={gt("Prompt advisor")}>
        <SettingsRow
          title={
            settings.loadError === null
              ? gt("Loading…")
              : gt("Could not load the prompt advisor settings.")
          }
          description={settings.loadError ?? undefined}
          control={
            settings.loadError === null ? undefined : (
              <Button size="xs" variant="outline" onClick={() => settings.refresh()}>
                {gt("Retry")}
              </Button>
            )
          }
        />
      </SettingsSection>
    );
  }
  const view = { ...payload, config };
  const test = (request: PromptAdvisorTestRequest) =>
    void settings.runTest(settings.dirty ? { ...request, config } : request);
  return (
    <>
      <AdvisorBlock
        payload={view}
        disabled={settings.saving}
        test={settings.tests.advisor}
        dirty={settings.dirty}
        onEdit={settings.edit}
        onRefresh={() => settings.refresh()}
        onTest={(scenario) => test({ role: "advisor", scenario })}
      />
      <RefinerBlock
        payload={view}
        disabled={settings.saving}
        test={settings.tests.refiner}
        dirty={settings.dirty}
        onEdit={settings.edit}
        onRefresh={() => settings.refresh()}
        onTest={(mode) => test({ role: "refiner", mode })}
      />
      {settings.dirty || settings.saveError !== null ? (
        <div
          role="group"
          aria-label={gt("Unsaved changes")}
          className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm sm:px-4"
        >
          <p className="min-w-0 text-xs text-muted-foreground">
            {settings.saveError === null ? (
              gt("Unsaved changes. Previews and live status still show the saved settings.")
            ) : (
              <span role="alert" className="text-destructive">
                {settings.saveError}
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={settings.saving}
              onClick={() => settings.discard()}
            >
              {gt("Discard")}
            </Button>
            <Button
              size="xs"
              disabled={settings.saving || !settings.dirty}
              onClick={() => void settings.save()}
            >
              {gt("Save")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
