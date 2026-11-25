import * as Effect from "effect/Effect";

import type { PromptAdvisorInspection, PromptAdvisorRuntime } from "./promptAdvisor.cn.ts";

const IDLE_ACTIVITY = { lastSampleAt: null, lastDurationMs: null, lastError: null };

export const IDLE_INSPECTION: PromptAdvisorInspection = {
  available: true,
  slots: [],
  activity: { advisor: IDLE_ACTIVITY, refiner: IDLE_ACTIVITY },
};

/** A runtime double: every member is inert unless the test overrides it. */
export const stubPromptAdvisorRuntime = (
  overrides: Partial<PromptAdvisorRuntime> = {},
): PromptAdvisorRuntime => {
  const sample = overrides.sample ?? (() => Effect.succeed(null));
  return {
    available: Effect.succeed(true),
    sample,
    sampleDetailed: (input) =>
      Effect.map(sample(input), (encoded) => ({
        _tag: "Parsed" as const,
        encoded,
        received: encoded === null ? 0 : 1,
        dropped: 0,
      })),
    runPrompt: () => Effect.succeed("{}"),
    runIsolated: () =>
      Effect.succeed({
        output: "{}",
        live: {
          activeModel: null,
          activeThinking: null,
          availableModels: [],
          availableThinking: [],
        },
      }),
    inspect: Effect.succeed(IDLE_INSPECTION),
    retain: () => Effect.void,
    release: () => Effect.void,
    ...overrides,
  };
};
