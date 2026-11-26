import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface RoleModelSelection {
  /** null = automatic: the default Antigravity instance first. */
  readonly instanceId: string | null;
  /** null = automatic: Neon, Hydrogen, 3.8 Flash, then the instance default. */
  readonly model: string | null;
  /** null = automatic: low, minimal, off, none, medium. */
  readonly thinking: string | null;
}

export interface PromptAdvisorLensesConfig {
  readonly grilling: boolean;
  readonly debugging: boolean;
  readonly blastRadius: boolean;
}

export interface SessionSpriteConfig {
  readonly enabled: boolean;
  readonly mode: "shadow";
  readonly scanIntervalMinutes: number;
  readonly idleMinutes: number;
  readonly maxPerThreadPerHumanTurn: number;
  readonly maxGlobalPerHour: number;
  readonly quietHoursEnabled: boolean;
  readonly quietStartHour: number;
  readonly quietEndHour: number;
  readonly blockedTitleKeywords: ReadonlyArray<string>;
}

export interface PromptAdvisorConfig {
  readonly version: 1;
  readonly advisor: {
    readonly runtime: RoleModelSelection;
    readonly lenses: PromptAdvisorLensesConfig;
    readonly customAppendix: string;
    readonly promptOverride: string;
  };
  readonly refiner: {
    readonly followAdvisorRuntime: boolean;
    readonly runtime: RoleModelSelection;
    readonly modeOverrides: {
      readonly structured: string;
      readonly bold: string;
      readonly scoped: string;
    };
  };
  readonly sprite: SessionSpriteConfig;
}

export type PromptAdvisorRole = "advisor" | "refiner";

const AUTOMATIC: RoleModelSelection = { instanceId: null, model: null, thinking: null };

export const DEFAULT_SESSION_SPRITE_CONFIG: SessionSpriteConfig = {
  enabled: false,
  mode: "shadow",
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

export const DEFAULT_PROMPT_ADVISOR_CONFIG: PromptAdvisorConfig = {
  version: 1,
  advisor: {
    runtime: AUTOMATIC,
    lenses: { grilling: true, debugging: true, blastRadius: true },
    customAppendix: "",
    promptOverride: "",
  },
  refiner: {
    followAdvisorRuntime: true,
    runtime: AUTOMATIC,
    modeOverrides: { structured: "", bold: "", scoped: "" },
  },
  sprite: DEFAULT_SESSION_SPRITE_CONFIG,
};

const MAX_ID_CHARS = 128;
const MAX_APPENDIX_CHARS = 2_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_BLOCKED_KEYWORDS = 64;
const MAX_KEYWORD_CHARS = 64;

const Identifier = Schema.NullOr(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ID_CHARS)),
);
const RoleModelSelectionSchema = Schema.Struct({
  instanceId: Identifier,
  model: Identifier,
  thinking: Identifier,
});
const Prompt = Schema.String.check(Schema.isMaxLength(MAX_PROMPT_CHARS));
const BlockedKeyword = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_KEYWORD_CHARS),
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
  blockedTitleKeywords: Schema.Array(BlockedKeyword).check(
    Schema.isMaxLength(MAX_BLOCKED_KEYWORDS),
  ),
});

const PromptAdvisorConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  advisor: Schema.Struct({
    runtime: RoleModelSelectionSchema,
    lenses: Schema.Struct({
      grilling: Schema.Boolean,
      debugging: Schema.Boolean,
      blastRadius: Schema.Boolean,
    }),
    customAppendix: Schema.String.check(Schema.isMaxLength(MAX_APPENDIX_CHARS)),
    promptOverride: Prompt,
  }),
  refiner: Schema.Struct({
    followAdvisorRuntime: Schema.Boolean,
    runtime: RoleModelSelectionSchema,
    modeOverrides: Schema.Struct({ structured: Prompt, bold: Prompt, scoped: Prompt }),
  }),
  sprite: SessionSpriteConfigSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_SESSION_SPRITE_CONFIG)),
  ),
});
const decodeConfig = Schema.decodeUnknownOption(PromptAdvisorConfigSchema);
const ConfigJson = Schema.fromJsonString(PromptAdvisorConfigSchema);
const decodeConfigJson = Schema.decodeUnknownOption(ConfigJson);
const encodeConfigJson = Schema.encodeEffect(ConfigJson);

/** The config when `value` is a complete, valid one; anything else is none. */
export const decodePromptAdvisorConfig = (value: unknown): Option.Option<PromptAdvisorConfig> =>
  decodeConfig(value);

/** What a role actually runs on: the refiner borrows the advisor's selection while it follows. */
export const resolveRoleTarget = (
  config: PromptAdvisorConfig,
  role: PromptAdvisorRole,
): RoleModelSelection =>
  role === "advisor" || config.refiner.followAdvisorRuntime
    ? config.advisor.runtime
    : config.refiner.runtime;

/** The roles whose wording changed; a warm helper still holds a session written under the old one. */
export const rolesWithChangedPrompts = (
  previous: PromptAdvisorConfig,
  next: PromptAdvisorConfig,
): ReadonlyArray<PromptAdvisorRole> => {
  const advisorChanged =
    previous.advisor.customAppendix !== next.advisor.customAppendix ||
    previous.advisor.promptOverride !== next.advisor.promptOverride ||
    previous.advisor.lenses.grilling !== next.advisor.lenses.grilling ||
    previous.advisor.lenses.debugging !== next.advisor.lenses.debugging ||
    previous.advisor.lenses.blastRadius !== next.advisor.lenses.blastRadius;
  const refinerChanged =
    previous.refiner.modeOverrides.structured !== next.refiner.modeOverrides.structured ||
    previous.refiner.modeOverrides.bold !== next.refiner.modeOverrides.bold ||
    previous.refiner.modeOverrides.scoped !== next.refiner.modeOverrides.scoped;
  return [
    ...(advisorChanged ? ["advisor" as const] : []),
    ...(refinerChanged ? ["refiner" as const] : []),
  ];
};

/**
 * Warm helpers are told apart by what was asked for. The model the helper settles on is only known
 * after it started, so a cold slot cannot be matched by its resolved model.
 */
export const targetSignature = (target: Pick<RoleModelSelection, "model" | "thinking">): string =>
  `${target.model ?? "auto"}|${target.thinking ?? "auto"}`;

// Process-wide like the advisor registry: the route loads it, the samplers read it per request.
let active: PromptAdvisorConfig = DEFAULT_PROMPT_ADVISOR_CONFIG;

export const getPromptAdvisorConfig = (): PromptAdvisorConfig => active;

export const setPromptAdvisorConfig = (config: PromptAdvisorConfig): void => {
  active = config;
};

/** The saved config; a missing or damaged file is the default and is left untouched. */
export const loadPromptAdvisorConfig = Effect.fn("PromptAdvisorConfig.load")(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(filePath);
    return Option.getOrElse(decodeConfigJson(source), () => DEFAULT_PROMPT_ADVISOR_CONFIG);
  },
  Effect.catchCause(() => Effect.succeed(DEFAULT_PROMPT_ADVISOR_CONFIG)),
);

/** Writes a sibling file first so a crash never leaves a half-written config behind. */
export const savePromptAdvisorConfig = Effect.fn("PromptAdvisorConfig.save")(function* (
  filePath: string,
  config: PromptAdvisorConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${filePath}.tmp`;
  yield* fs.writeFileString(temporary, `${yield* encodeConfigJson(config)}\n`);
  yield* fs.rename(temporary, filePath);
});
