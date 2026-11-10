// Settles which plugins should be active from their dependencies, then applies it in dependency order.
import type { PluginHostState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { injectedServices, providedServices, type Slot } from "./PluginSlot.ts";

type Claims = (slot: Slot) => boolean;

/** The first plugin of `include` to declare each service name; a service has one provider. */
export const serviceOwners = (slots: Iterable<Slot>, include: (slot: Slot) => boolean) => {
  const owners = new Map<string, Slot>();
  for (const slot of slots)
    if (include(slot))
      for (const name of providedServices(slot)) if (!owners.has(name)) owners.set(name, slot);
  return owners;
};

/** How deep each plugin sits in the dependency graph: 0 without plugin dependencies, else one more than its deepest provider. */
export const dependencyRanks = (all: ReadonlyArray<Slot>, claims: Claims) => {
  const owners = serviceOwners(
    all,
    (slot) => slot.registration !== undefined && (claims(slot) || slot.scope !== undefined),
  );
  const ranks = new Map<Slot, number>();
  const rank = (slot: Slot, visiting: ReadonlySet<Slot>): number => {
    const known = ranks.get(slot);
    if (known !== undefined) return known;
    const depth = Math.max(
      -1,
      ...injectedServices(slot).flatMap((name) => {
        const provider = owners.get(name);
        return provider === undefined || provider === slot || visiting.has(provider)
          ? []
          : [rank(provider, new Set([...visiting, slot]))];
      }),
    );
    ranks.set(slot, depth + 1);
    return depth + 1;
  };
  for (const slot of all) rank(slot, new Set());
  return ranks;
};

export interface ReconcilePlan {
  readonly conflicts: ReadonlyMap<Slot, string | undefined>;
  /** Open plugins that should not be, dependents first. */
  readonly stop: ReadonlyArray<Slot>;
  /** Plugins that should be active and are not, providers first. */
  readonly start: ReadonlyArray<Slot>;
  /** Plugins that want to run but cannot, with what they wait for. */
  readonly waiting: ReadonlyMap<Slot, { readonly waitingFor: string[]; readonly reason: string }>;
  /** Plugins that neither run nor wait. */
  readonly idle: ReadonlyArray<Slot>;
}

/**
 * Plugins that want to run, and whose injected services are all provided by plugins that
 * should be active and are not quarantined, are active (a fixed point). The rest of the
 * plugins that want to run wait; a cycle of them is named as one.
 */
export const planReconcile = (all: ReadonlyArray<Slot>, claims: Claims): ReconcilePlan => {
  const owners = serviceOwners(all, claims);
  const conflicts = new Map<Slot, string | undefined>();
  for (const slot of all) {
    const taken = providedServices(slot)
      .map((name) => ({ name, owner: owners.get(name) }))
      .find((candidate) => candidate.owner !== undefined && candidate.owner !== slot);
    conflicts.set(
      slot,
      claims(slot) && taken?.owner !== undefined
        ? `the service ${taken.name} is already provided by ${taken.owner.id}.`
        : undefined,
    );
  }
  const candidates = all.filter((slot) => claims(slot) && conflicts.get(slot) === undefined);
  const active = new Set<Slot>();
  const provides = (name: string, dependent: Slot) => {
    const provider = owners.get(name);
    return (
      provider !== undefined &&
      provider !== dependent &&
      active.has(provider) &&
      provider.state._tag !== "quarantined"
    );
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const slot of candidates)
      if (!active.has(slot) && injectedServices(slot).every((name) => provides(name, slot))) {
        active.add(slot);
        changed = true;
      }
  }

  const ranks = dependencyRanks(all, claims);
  const byRank = (direction: 1 | -1) => (left: Slot, right: Slot) =>
    direction * ((ranks.get(left) ?? 0) - (ranks.get(right) ?? 0));

  const cycleFrom = (origin: Slot) => {
    const walk = (slot: Slot, path: ReadonlyArray<Slot>): ReadonlyArray<Slot> | undefined => {
      for (const name of injectedServices(slot)) {
        const next = owners.get(name);
        if (next === undefined || active.has(next) || !candidates.includes(next)) continue;
        if (next === origin) return [...path, slot];
        if (path.includes(next) || next === slot) continue;
        const found = walk(next, [...path, slot]);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(origin, []);
  };
  const waiting = new Map<Slot, { waitingFor: string[]; reason: string }>();
  const idle: Array<Slot> = [];
  for (const slot of all.filter((candidate) => !active.has(candidate))) {
    if (!candidates.includes(slot)) {
      idle.push(slot);
      continue;
    }
    const waitingFor = injectedServices(slot).filter((name) => !provides(name, slot));
    const cycle = cycleFrom(slot);
    waiting.set(slot, {
      waitingFor,
      reason:
        cycle === undefined
          ? `waiting for ${waitingFor.join(", ")}`
          : `dependency cycle: ${[...cycle, slot].map((member) => member.id).join(" → ")}`,
    });
  }
  return {
    conflicts,
    stop: all.filter((slot) => slot.scope !== undefined && !active.has(slot)).toSorted(byRank(-1)),
    start: [...active].filter((slot) => slot.scope === undefined).toSorted(byRank(1)),
    waiting,
    idle,
  };
};

export interface ReconcileHooks {
  readonly stop: (slot: Slot) => Effect.Effect<void>;
  readonly start: (slot: Slot) => Effect.Effect<void>;
  readonly setState: (slot: Slot, state: PluginHostState) => Effect.Effect<void>;
  readonly emit: Effect.Effect<void>;
}

export const applyReconcilePlan = Effect.fn("PluginReconcile.apply")(function* (
  plan: ReconcilePlan,
  hooks: ReconcileHooks,
) {
  for (const [slot, conflict] of plan.conflicts) slot.conflict = conflict;
  for (const slot of plan.stop) yield* hooks.stop(slot);
  for (const slot of plan.start) yield* hooks.start(slot);
  for (const [slot, { waitingFor, reason }] of plan.waiting) {
    slot.waitingFor = waitingFor;
    yield* hooks.setState(slot, { _tag: "waiting", reason });
  }
  for (const slot of plan.idle) {
    slot.waitingFor = [];
    if (slot.state._tag !== "idle") yield* hooks.setState(slot, { _tag: "idle" });
  }
  yield* hooks.emit;
});
