import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PromptAdvisorSampler } from "./promptAdvisor.cn.ts";

// Process-wide on purpose: drivers register at instance creation and the session manager reads it,
// so neither needs a new service dependency in its layer.
const registered = new Map<string, PromptAdvisorSampler>();
const PREFERRED_INSTANCE_ID = "antigravity";

/** Offers `sampler` as a prompt advisor until the surrounding scope closes. */
export const registerPromptAdvisor = (instanceId: string, sampler: PromptAdvisorSampler) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      registered.set(instanceId, sampler);
    }),
    () =>
      Effect.sync(() => {
        if (registered.get(instanceId) === sampler) registered.delete(instanceId);
      }),
  );

/** The default Antigravity instance when it can run, otherwise any registered one that can. */
export const resolvePromptAdvisor: Effect.Effect<Option.Option<PromptAdvisorSampler>> = Effect.gen(
  function* () {
    const ordered = [...registered].toSorted(
      ([left], [right]) =>
        Number(right === PREFERRED_INSTANCE_ID) - Number(left === PREFERRED_INSTANCE_ID),
    );
    for (const [, sampler] of ordered) {
      if (yield* sampler.available) return Option.some(sampler);
    }
    return Option.none();
  },
);
