import type {
  PromptAdvisorConfig,
  PromptAdvisorPayload,
  PromptAdvisorStatus,
  RoleStatus,
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
