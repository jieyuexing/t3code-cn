/* oxlint-disable t3code/no-untranslated-copy -- test fixtures mimicking server-authored Chinese ledger entries */
import {
  DEFAULT_SESSION_SPRITE_CONFIG,
  type PromptAdvisorConfig,
  type PromptAdvisorPayload,
  type PromptAdvisorStatus,
  type RoleStatus,
  type SessionSpriteLedgerEntry,
  type SessionSpriteLedgerPayload,
  type SessionSpriteLedgerSummary,
} from "./promptAdvisorConfig.logic";

export const DEFAULT_CONFIG: PromptAdvisorConfig = {
  version: 1,
  advisor: {
    runtime: { instanceId: null, model: null, thinking: null },
    lenses: { grilling: true, debugging: true, blastRadius: true },
    customAppendix: "",
    promptOverride: "",
  },
  refiner: {
    followAdvisorRuntime: true,
    runtime: { instanceId: null, model: null, thinking: null },
    modeOverrides: { structured: "", bold: "", scoped: "" },
  },
  sprite: DEFAULT_SESSION_SPRITE_CONFIG,
};

export const roleStatus = (patch: Partial<RoleStatus> = {}): RoleStatus => ({
  state: "idle",
  requestedInstanceId: null,
  resolvedInstanceId: "antigravity",
  activeModel: null,
  activeThinking: null,
  modelSource: "preset",
  availableModels: ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon"],
  availableThinking: ["minimal", "low", "medium", "high"],
  uses: 0,
  maxUses: 20,
  sharesSlot: true,
  lastSampleAt: null,
  lastDurationMs: null,
  lastError: null,
  ...patch,
});

export const advisorStatus = (patch: Partial<PromptAdvisorStatus> = {}): PromptAdvisorStatus => ({
  instances: [
    { instanceId: "antigravity", available: true },
    { instanceId: "antigravity_2", available: true },
  ],
  advisor: roleStatus(),
  refiner: roleStatus(),
  ...patch,
});

export const advisorPayload = (
  patch: Partial<PromptAdvisorPayload> = {},
): PromptAdvisorPayload => ({
  config: DEFAULT_CONFIG,
  status: advisorStatus(),
  previews: {
    advisorPromptPreview: "ADVISOR PROMPT\nBEGIN CONVERSATION TRANSCRIPT",
    advisorExplicitPromptPreview: "EXPLICIT PROMPT",
    refinerModePreviews: {
      structured: "STRUCTURED FULL",
      bold: "BOLD FULL",
      scoped: "SCOPED FULL",
    },
    advisorBuiltInInstructions: "BUILT-IN ADVISOR INSTRUCTIONS",
    refinerBuiltInDirectives: {
      structured: "Mode structured: built-in",
      bold: "Mode bold: built-in",
      scoped: "Mode scoped: built-in",
    },
  },
  defaults: DEFAULT_CONFIG,
  ...patch,
});

export const spriteLedgerEntry = (
  patch: Partial<SessionSpriteLedgerEntry> = {},
): SessionSpriteLedgerEntry => ({
  ts: "2026-11-26T11:20:00.000Z",
  mode: "shadow",
  trigger: "manual",
  threadId: "thread-1",
  threadTitle: "登录页校验优化",
  runId: "run-1",
  decision: "would_advance",
  blockReason: null,
  keptItems: [{ kind: "next", label: "跑回归测试", fill: "跑一遍登录页测试并确认通过。" }],
  droppedItems: [],
  draftMessage:
    "[自动推进·只读核验｜非用户授权，禁做方向拍板/写操作/推送/公司侧改动]\n跑一遍登录页测试并确认通过。",
  durationMs: 420,
  ...patch,
});

export const spriteLedgerSummary = (
  patch: Partial<SessionSpriteLedgerSummary> = {},
): SessionSpriteLedgerSummary => ({
  totalEvaluated: 1,
  wouldAdvance: 1,
  blockedThread: 0,
  blockedItems: 0,
  errors: 0,
  lastScanAt: "2026-11-26T11:20:00.000Z",
  ...patch,
});

export const spriteLedgerPayload = (
  patch: Partial<SessionSpriteLedgerPayload> = {},
): SessionSpriteLedgerPayload => ({
  summary: spriteLedgerSummary(),
  entries: [spriteLedgerEntry()],
  ledgerPath: "/state/cn-session-sprite.jsonl",
  ...patch,
});
