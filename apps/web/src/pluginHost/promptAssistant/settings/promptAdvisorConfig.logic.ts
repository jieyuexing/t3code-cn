import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export const PROMPT_ADVISOR_PATHS = {
  config: "/prompt-advisor/config",
  testRun: "/prompt-advisor/test-run",
  spriteLedger: "/prompt-advisor/sprite/ledger",
  spriteScan: "/prompt-advisor/sprite/scan",
} as const;
export type PromptAdvisorPath = (typeof PROMPT_ADVISOR_PATHS)[keyof typeof PROMPT_ADVISOR_PATHS];

export const MAX_APPENDIX_CHARS = 2_000;
export const MAX_PROMPT_CHARS = 8_000;
export const MAX_SPRITE_BLOCKED_KEYWORDS = 64;
export const MAX_SPRITE_KEYWORD_CHARS = 64;
const AUTO_VALUE = "__auto__";

export const DEFAULT_SESSION_SPRITE_CONFIG = {
  enabled: false,
  mode: "shadow" as const,
  scanIntervalMinutes: 10,
  idleMinutes: 5,
  maxPerThreadPerHumanTurn: 1,
  maxGlobalPerHour: 3,
  quietHoursEnabled: true,
  quietStartHour: 22,
  quietEndHour: 8,
  blockedTitleKeywords: [
    "GWH-",
    "NSNET-",
    "ETECH",
    "SIR",
    "work",
    "141",
    "CostMan",
    "台式机",
    "定时任务",
    "巡检",
    "每周维护",
    "每日同步",
  ],
};

const BlockedKeywordSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SPRITE_KEYWORD_CHARS),
);

const SessionSpriteConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  mode: Schema.Literal("shadow"),
  scanIntervalMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 60 })),
  idleMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  maxPerThreadPerHumanTurn: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  maxGlobalPerHour: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
  quietHoursEnabled: Schema.Boolean,
  quietStartHour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  quietEndHour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  blockedTitleKeywords: Schema.Array(BlockedKeywordSchema).check(
    Schema.isMaxLength(MAX_SPRITE_BLOCKED_KEYWORDS),
  ),
});

const RoleModelSelectionSchema = Schema.Struct({
  instanceId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  thinking: Schema.NullOr(Schema.String),
});
const ConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  advisor: Schema.Struct({
    runtime: RoleModelSelectionSchema,
    lenses: Schema.Struct({
      grilling: Schema.Boolean,
      debugging: Schema.Boolean,
      blastRadius: Schema.Boolean,
    }),
    customAppendix: Schema.String,
    promptOverride: Schema.String,
  }),
  refiner: Schema.Struct({
    followAdvisorRuntime: Schema.Boolean,
    runtime: RoleModelSelectionSchema,
    modeOverrides: Schema.Struct({
      structured: Schema.String,
      bold: Schema.String,
      scoped: Schema.String,
    }),
  }),
  sprite: SessionSpriteConfigSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SESSION_SPRITE_CONFIG)),
  ),
});
const RoleStatusSchema = Schema.Struct({
  state: Schema.Literals(["warm", "idle", "unavailable"]),
  requestedInstanceId: Schema.NullOr(Schema.String),
  resolvedInstanceId: Schema.NullOr(Schema.String),
  activeModel: Schema.NullOr(Schema.String),
  activeThinking: Schema.NullOr(Schema.String),
  modelSource: Schema.Literals(["live", "preset"]),
  availableModels: Schema.Array(Schema.String),
  availableThinking: Schema.Array(Schema.String),
  uses: Schema.Number,
  maxUses: Schema.Number,
  sharesSlot: Schema.Boolean,
  lastSampleAt: Schema.NullOr(Schema.Number),
  lastDurationMs: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
});
const ModePrompts = Schema.Struct({
  structured: Schema.String,
  bold: Schema.String,
  scoped: Schema.String,
});
const StatusSchema = Schema.Struct({
  instances: Schema.Array(Schema.Struct({ instanceId: Schema.String, available: Schema.Boolean })),
  advisor: RoleStatusSchema,
  refiner: RoleStatusSchema,
});
const PayloadSchema = Schema.Struct({
  config: ConfigSchema,
  status: StatusSchema,
  previews: Schema.Struct({
    advisorPromptPreview: Schema.String,
    advisorExplicitPromptPreview: Schema.String,
    refinerModePreviews: ModePrompts,
    advisorBuiltInInstructions: Schema.String,
    refinerBuiltInDirectives: ModePrompts,
  }),
  defaults: ConfigSchema,
});

export type PromptAdvisorConfig = typeof ConfigSchema.Type;
export type SessionSpriteConfig = PromptAdvisorConfig["sprite"];
export type RoleModelSelection = PromptAdvisorConfig["advisor"]["runtime"];
export type RoleStatus = typeof RoleStatusSchema.Type;
export type PromptAdvisorStatus = typeof StatusSchema.Type;
export type PromptAdvisorPayload = typeof PayloadSchema.Type;
export type LensKey = keyof PromptAdvisorConfig["advisor"]["lenses"];
export type RefineModeKey = keyof PromptAdvisorConfig["refiner"]["modeOverrides"];

const LedgerItemSchema = Schema.Struct({
  kind: Schema.Literals(["challenge", "next", "angle"]),
  label: Schema.String,
  fill: Schema.String,
});
const LedgerDroppedItemSchema = Schema.Struct({
  kind: Schema.Literals(["challenge", "next", "angle"]),
  label: Schema.String,
  fill: Schema.String,
  grade: Schema.Literals(["A", "B", "C"]),
  reason: Schema.String,
});
const SessionSpriteLedgerEntrySchema = Schema.Struct({
  ts: Schema.String,
  mode: Schema.Literal("shadow"),
  trigger: Schema.Literals(["periodic", "manual"]),
  threadId: Schema.String,
  threadTitle: Schema.String,
  runId: Schema.String,
  decision: Schema.Literals(["would_advance", "blocked_thread", "blocked_items", "error"]),
  blockReason: Schema.NullOr(Schema.String),
  keptItems: Schema.Array(LedgerItemSchema),
  droppedItems: Schema.Array(LedgerDroppedItemSchema),
  draftMessage: Schema.NullOr(Schema.String),
  durationMs: Schema.Finite,
});
const SessionSpriteLedgerSummarySchema = Schema.Struct({
  totalEvaluated: Schema.Number,
  wouldAdvance: Schema.Number,
  blockedThread: Schema.Number,
  blockedItems: Schema.Number,
  errors: Schema.Number,
  lastScanAt: Schema.NullOr(Schema.String),
});
const SessionSpriteLedgerPayloadSchema = Schema.Struct({
  summary: SessionSpriteLedgerSummarySchema,
  entries: Schema.Array(SessionSpriteLedgerEntrySchema),
  ledgerPath: Schema.String,
});
const SessionSpriteScanResultSchema = Schema.Struct({
  scanned: Schema.Number,
  wouldAdvance: Schema.Number,
  blocked: Schema.Number,
  errors: Schema.Number,
  summary: SessionSpriteLedgerSummarySchema,
  entries: Schema.Array(SessionSpriteLedgerEntrySchema),
});

export type SessionSpriteLedgerEntry = typeof SessionSpriteLedgerEntrySchema.Type;
export type SessionSpriteLedgerSummary = typeof SessionSpriteLedgerSummarySchema.Type;
export type SessionSpriteLedgerPayload = typeof SessionSpriteLedgerPayloadSchema.Type;
export type SessionSpriteScanResult = typeof SessionSpriteScanResultSchema.Type;
export interface SessionSpriteScanRequest {
  readonly bypassQuietHours?: boolean;
  readonly bypassIdle?: boolean;
}

export const ADVISOR_TEST_SCENARIOS = ["vague", "debugging", "explicit_choices"] as const;
export type AdvisorTestScenario = (typeof ADVISOR_TEST_SCENARIOS)[number];
export const REFINE_MODES = ["structured", "bold", "scoped"] as const;

/** `config` is an unsaved draft the run should use instead of the saved settings. */
export type PromptAdvisorTestRequest = (
  | { readonly role: "advisor"; readonly scenario: AdvisorTestScenario }
  | { readonly role: "refiner"; readonly mode: RefineModeKey }
) & { readonly config?: PromptAdvisorConfig };

const TestRunSchema = Schema.Struct({
  role: Schema.Literals(["advisor", "refiner"]),
  durationMs: Schema.Number,
  items: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["challenge", "next", "angle"]),
        label: Schema.String,
        fill: Schema.String,
      }),
    ),
  ),
  /** How many entries the app's rules removed from the model's answer. */
  dropped: Schema.optional(Schema.Number),
  refined: Schema.optional(Schema.String),
  draft: Schema.Boolean,
  ran: Schema.Struct({
    resolvedInstanceId: Schema.NullOr(Schema.String),
    activeModel: Schema.NullOr(Schema.String),
    activeThinking: Schema.NullOr(Schema.String),
  }),
  status: StatusSchema,
});
const FailureSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
});
export type PromptAdvisorTestRun = typeof TestRunSchema.Type;

const decodePayload = Schema.decodeUnknownOption(PayloadSchema);
const decodeTestRun = Schema.decodeUnknownOption(TestRunSchema);
const decodeFailure = Schema.decodeUnknownOption(FailureSchema);
const decodeSpriteLedger = Schema.decodeUnknownOption(SessionSpriteLedgerPayloadSchema);
const decodeSpriteScan = Schema.decodeUnknownOption(SessionSpriteScanResultSchema);

export const parsePromptAdvisorPayload = (value: unknown): PromptAdvisorPayload | null =>
  Option.getOrNull(decodePayload(value));
export const parsePromptAdvisorTestRun = (value: unknown): PromptAdvisorTestRun | null =>
  Option.getOrNull(decodeTestRun(value));
export const parseSessionSpriteLedger = (value: unknown): SessionSpriteLedgerPayload | null =>
  Option.getOrNull(decodeSpriteLedger(value));
export const parseSessionSpriteScan = (value: unknown): SessionSpriteScanResult | null =>
  Option.getOrNull(decodeSpriteScan(value));
/** What a failed call says: the server's reason and, when it sent one, the latest status. */
export const parsePromptAdvisorFailure = (value: unknown) =>
  Option.getOrElse(decodeFailure(value), () => ({}) as typeof FailureSchema.Type);

export const promptAdvisorUrl = (
  access: { readonly httpBase: string; readonly query: Readonly<Record<string, string>> },
  path: PromptAdvisorPath,
): string => {
  const search = new URLSearchParams(Object.entries(access.query)).toString();
  return `${access.httpBase}${path}${search === "" ? "" : `?${search}`}`;
};

export const PROMPT_ADVISOR_COPY = {
  loadFailed: msg("Could not load the prompt advisor settings."),
  saveFailed: msg("Could not save the prompt advisor settings."),
  notConnected: msg("Not connected to the environment yet. Try again shortly."),
  unreachable: msg("Could not reach the server. Check your connection and try again."),
  unrecognized: msg("The server returned an unrecognized response."),
  sessionExpired: msg("Session expired. Reconnect and try again."),
  forbidden: msg("This session does not have permission to change these settings."),
  invalid: msg("The server rejected these settings."),
} as const;

export function configFailureMessage(status: number, resolve: MessageResolver = m): string {
  switch (status) {
    case 503:
      return resolve(
        msg("No prompt advisor available (requires a signed-in Antigravity account)."),
      );
    case 401:
      return resolve(PROMPT_ADVISOR_COPY.sessionExpired);
    case 403:
      return resolve(PROMPT_ADVISOR_COPY.forbidden);
    case 400:
      return resolve(PROMPT_ADVISOR_COPY.invalid);
    default:
      return resolve(msg("Request failed ({status}).", { status }));
  }
}

/** Select items carry strings, so "automatic" travels as a sentinel instead of null. */
export const toSelectValue = (value: string | null): string => value ?? AUTO_VALUE;
export const fromSelectValue = (value: string): string | null =>
  value === AUTO_VALUE ? null : value;

export type RuntimeRole = "advisor" | "refiner";

export function withRuntime(
  config: PromptAdvisorConfig,
  role: RuntimeRole,
  patch: Partial<RoleModelSelection>,
): PromptAdvisorConfig {
  return role === "advisor"
    ? {
        ...config,
        advisor: { ...config.advisor, runtime: { ...config.advisor.runtime, ...patch } },
      }
    : {
        ...config,
        refiner: { ...config.refiner, runtime: { ...config.refiner.runtime, ...patch } },
      };
}

export const withFollow = (config: PromptAdvisorConfig, follow: boolean): PromptAdvisorConfig => ({
  ...config,
  refiner: { ...config.refiner, followAdvisorRuntime: follow },
});

export const withLens = (
  config: PromptAdvisorConfig,
  lens: LensKey,
  enabled: boolean,
): PromptAdvisorConfig => ({
  ...config,
  advisor: { ...config.advisor, lenses: { ...config.advisor.lenses, [lens]: enabled } },
});

export const withAdvisorText = (
  config: PromptAdvisorConfig,
  field: "customAppendix" | "promptOverride",
  text: string,
): PromptAdvisorConfig => ({ ...config, advisor: { ...config.advisor, [field]: text } });

export const withModeOverride = (
  config: PromptAdvisorConfig,
  mode: RefineModeKey,
  text: string,
): PromptAdvisorConfig => ({
  ...config,
  refiner: { ...config.refiner, modeOverrides: { ...config.refiner.modeOverrides, [mode]: text } },
});

export const withSprite = (
  config: PromptAdvisorConfig,
  patch: Partial<SessionSpriteConfig>,
): PromptAdvisorConfig => ({
  ...config,
  sprite: { ...config.sprite, ...patch },
});

export function parseKeywordsInput(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of text.split(/[,，\r\n]+/)) {
    const trimmed = raw.trim().slice(0, MAX_SPRITE_KEYWORD_CHARS).trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_SPRITE_BLOCKED_KEYWORDS) break;
  }
  return result;
}

export const formatKeywordsInput = (list: ReadonlyArray<string>): string => list.join("\n");

export const numberChoicesWith = (
  offered: ReadonlyArray<number>,
  selected: number,
): ReadonlyArray<number> =>
  offered.includes(selected)
    ? offered
    : [...offered, selected].toSorted((left, right) => left - right);

/** The listed choices, plus a saved choice the helper no longer offers so it stays visible. */
export const choicesWith = (
  offered: ReadonlyArray<string>,
  selected: string | null,
): ReadonlyArray<string> =>
  selected === null || offered.includes(selected) ? offered : [...offered, selected];

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** One line of facts for a role's status bar; the state and its source come first. */
export function describeRoleStatus(status: RoleStatus, resolve: MessageResolver = m): string {
  const state =
    status.state === "warm"
      ? resolve(msg("Warm", { $context: "helper process state, already running" }))
      : status.state === "idle"
        ? resolve(msg("Idle, starts on demand"))
        : resolve(msg("Unavailable"));
  if (status.state === "unavailable") return state;
  const model = status.activeModel ?? resolve(msg("auto", { $context: "automatic model choice" }));
  const thinking =
    status.activeThinking ?? resolve(msg("auto", { $context: "automatic model choice" }));
  const source =
    status.modelSource === "live"
      ? resolve(msg("measured", { $context: "model list source, reported by a running helper" }))
      : resolve(msg("preset", { $context: "model list source, built-in list" }));
  const parts = [
    state,
    status.resolvedInstanceId ?? "",
    `${model} / ${thinking} (${source})`,
    resolve(msg("reused {uses}/{max}", { uses: status.uses, max: status.maxUses })),
  ].filter((part) => part !== "");
  if (status.lastDurationMs !== null) {
    parts.push(resolve(msg("last {time}", { time: formatSeconds(status.lastDurationMs) })));
  }
  return parts.join(" · ");
}

/** Where the refiner's helper comes from, for its status bar. */
export function describeSlotSharing(status: RoleStatus, resolve: MessageResolver = m): string {
  return status.sharesSlot
    ? resolve(msg("Shares the context advisor's warm process."))
    : resolve(msg("Runs on its own warm process."));
}

/** Where a test run actually ran, as a short line. */
export function describeRan(
  ran: PromptAdvisorTestRun["ran"],
  resolve: MessageResolver = m,
): string {
  const auto = resolve(msg("auto", { $context: "automatic model choice" }));
  return [
    ran.resolvedInstanceId ?? "",
    `${ran.activeModel ?? auto} / ${ran.activeThinking ?? auto}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );

export const sameConfig = (left: PromptAdvisorConfig, right: PromptAdvisorConfig): boolean =>
  canonical(left) === canonical(right);
