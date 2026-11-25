import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PROMPT_ADVISOR_PRESET_MODELS,
  PROMPT_ADVISOR_PRESET_THINKING,
  type PromptAdvisorInspection,
  type PromptAdvisorRoleActivity,
  type PromptAdvisorRuntime,
} from "./promptAdvisor.cn.ts";
import {
  getPromptAdvisorConfig,
  type PromptAdvisorConfig,
  type PromptAdvisorRole,
  resolveRoleTarget,
  targetSignature,
} from "./promptAdvisorConfig.cn.ts";

// Process-wide on purpose: drivers register at instance creation and the session manager reads it,
// so neither needs a new service dependency in its layer.
const registered = new Map<string, PromptAdvisorRuntime>();
const PREFERRED_INSTANCE_ID = "antigravity";
const MAX_USES = 20;

/** Offers `sampler` as a prompt advisor until the surrounding scope closes. */
export const registerPromptAdvisor = (instanceId: string, sampler: PromptAdvisorRuntime) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      registered.set(instanceId, sampler);
    }),
    () =>
      Effect.sync(() => {
        if (registered.get(instanceId) === sampler) registered.delete(instanceId);
      }),
  );

export interface ResolvedRuntime {
  readonly instanceId: string;
  readonly runtime: PromptAdvisorRuntime;
}

/**
 * The instance a role runs on: the one its config names while it can run, otherwise the default
 * Antigravity instance, otherwise any registered one that can.
 */
export const resolvePromptRole = Effect.fn("PromptAdvisorRegistry.resolveRole")(function* (
  role: PromptAdvisorRole,
  config: PromptAdvisorConfig,
) {
  const requested = resolveRoleTarget(config, role).instanceId;
  const named = requested === null ? undefined : registered.get(requested);
  if (requested !== null && named !== undefined && (yield* named.available)) {
    return Option.some<ResolvedRuntime>({ instanceId: requested, runtime: named });
  }
  const ordered = [...registered].toSorted(
    ([left], [right]) =>
      Number(right === PREFERRED_INSTANCE_ID) - Number(left === PREFERRED_INSTANCE_ID),
  );
  for (const [instanceId, runtime] of ordered) {
    if (yield* runtime.available) return Option.some<ResolvedRuntime>({ instanceId, runtime });
  }
  return Option.none<ResolvedRuntime>();
});

const runtimeOf = (role: PromptAdvisorRole) =>
  Effect.map(
    Effect.suspend(() => resolvePromptRole(role, getPromptAdvisorConfig())),
    Option.map(({ runtime }) => runtime),
  );

/** The runtime that samples next-message suggestions. */
export const resolvePromptAdvisor: Effect.Effect<Option.Option<PromptAdvisorRuntime>> =
  runtimeOf("advisor");

/** The runtime that rewrites a draft. */
export const resolvePromptRefiner: Effect.Effect<Option.Option<PromptAdvisorRuntime>> =
  runtimeOf("refiner");

const ROLES = ["advisor", "refiner"] as const;

/** Releases the helpers no role points at any more; a role whose target did not change keeps its own. */
export const retainPromptAdvisorSlots = Effect.fn("PromptAdvisorRegistry.retain")(function* (
  config: PromptAdvisorConfig,
) {
  const keep = new Map<PromptAdvisorRuntime, Set<string>>();
  for (const role of ROLES) {
    const resolved = yield* resolvePromptRole(role, config);
    if (Option.isNone(resolved)) continue;
    const signatures = keep.get(resolved.value.runtime) ?? new Set<string>();
    signatures.add(targetSignature(resolveRoleTarget(config, role)));
    keep.set(resolved.value.runtime, signatures);
  }
  for (const runtime of registered.values()) {
    yield* runtime.retain(keep.get(runtime) ?? new Set());
  }
});

/** Restarts the helper each of `roles` runs on; a role on a different helper is left alone. */
export const releasePromptAdvisorSlots = Effect.fn("PromptAdvisorRegistry.release")(function* (
  config: PromptAdvisorConfig,
  roles: ReadonlyArray<PromptAdvisorRole>,
) {
  const drop = new Map<PromptAdvisorRuntime, Set<string>>();
  for (const role of roles) {
    const resolved = yield* resolvePromptRole(role, config);
    if (Option.isNone(resolved)) continue;
    const signatures = drop.get(resolved.value.runtime) ?? new Set<string>();
    signatures.add(targetSignature(resolveRoleTarget(config, role)));
    drop.set(resolved.value.runtime, signatures);
  }
  for (const [runtime, signatures] of drop) yield* runtime.release(signatures);
});

export interface PromptAdvisorRoleStatus extends PromptAdvisorRoleActivity {
  /** warm: a helper is running; idle: ready to start one; unavailable: no instance can run. */
  readonly state: "warm" | "idle" | "unavailable";
  readonly requestedInstanceId: string | null;
  readonly resolvedInstanceId: string | null;
  readonly activeModel: string | null;
  readonly activeThinking: string | null;
  /** live: reported by a helper that ran; preset: the built-in list a cold slot offers. */
  readonly modelSource: "live" | "preset";
  readonly availableModels: ReadonlyArray<string>;
  readonly availableThinking: ReadonlyArray<string>;
  readonly uses: number;
  readonly maxUses: number;
  /** The other role runs on this very helper. */
  readonly sharesSlot: boolean;
}

export interface PromptAdvisorStatus {
  readonly instances: ReadonlyArray<{ readonly instanceId: string; readonly available: boolean }>;
  readonly advisor: PromptAdvisorRoleStatus;
  readonly refiner: PromptAdvisorRoleStatus;
}

const roleStatus = (
  role: PromptAdvisorRole,
  config: PromptAdvisorConfig,
  resolved: Option.Option<ResolvedRuntime>,
  inspection: Option.Option<PromptAdvisorInspection>,
  sharesSlot: boolean,
): PromptAdvisorRoleStatus => {
  const target = resolveRoleTarget(config, role);
  const known = Option.getOrUndefined(inspection);
  const slot = known?.slots.find(({ signature }) => signature === targetSignature(target));
  const activity = known?.activity[role] ?? {
    lastSampleAt: null,
    lastDurationMs: null,
    lastError: null,
  };
  return {
    ...activity,
    state: Option.isNone(resolved) ? "unavailable" : slot?.warm === true ? "warm" : "idle",
    requestedInstanceId: target.instanceId,
    resolvedInstanceId: Option.match(resolved, {
      onNone: () => null,
      onSome: ({ instanceId }) => instanceId,
    }),
    activeModel: slot?.live.activeModel ?? target.model,
    activeThinking: slot?.live.activeThinking ?? target.thinking,
    modelSource: slot === undefined ? "preset" : "live",
    availableModels: slot?.live.availableModels ?? PROMPT_ADVISOR_PRESET_MODELS,
    availableThinking: slot?.live.availableThinking ?? PROMPT_ADVISOR_PRESET_THINKING,
    uses: slot?.uses ?? 0,
    maxUses: MAX_USES,
    sharesSlot,
  };
};

/** What the settings page shows. Reads memory only: a cold helper stays cold. */
export const describePromptAdvisors = Effect.fn("PromptAdvisorRegistry.describe")(function* (
  config: PromptAdvisorConfig,
) {
  const instances = yield* Effect.forEach([...registered], ([instanceId, runtime]) =>
    Effect.map(runtime.available, (available) => ({ instanceId, available })),
  );
  const advisor = yield* resolvePromptRole("advisor", config);
  const refiner = yield* resolvePromptRole("refiner", config);
  const [advisorInspection = Option.none(), refinerInspection = Option.none()] =
    yield* Effect.forEach([advisor, refiner], (resolved) =>
      Option.isNone(resolved) ? Effect.succeedNone : Effect.asSome(resolved.value.runtime.inspect),
    );
  const sharesSlot =
    Option.isSome(advisor) &&
    Option.isSome(refiner) &&
    advisor.value.runtime === refiner.value.runtime &&
    targetSignature(resolveRoleTarget(config, "advisor")) ===
      targetSignature(resolveRoleTarget(config, "refiner"));
  return {
    instances,
    advisor: roleStatus("advisor", config, advisor, advisorInspection, sharesSlot),
    refiner: roleStatus("refiner", config, refiner, refinerInspection, sharesSlot),
  } satisfies PromptAdvisorStatus;
});
