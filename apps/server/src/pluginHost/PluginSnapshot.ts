import type { PluginHostEntry, PluginHostSnapshot } from "@t3tools/contracts";

import { serviceOwners } from "./PluginReconcile.ts";
import { serviceAvailable, type Slot } from "./PluginSlot.ts";

const entryOf = (slot: Slot): PluginHostEntry => {
  const registration = slot.registration;
  const problem = slot.problem ?? slot.conflict;
  return {
    id: slot.id,
    name: registration?.manifest.name ?? slot.id,
    version: registration?.manifest.version ?? "",
    directory: registration?.directory ?? slot.path,
    enabled: slot.enabled,
    consent: slot.consent,
    digest: registration?.digest ?? "",
    capabilities: registration?.manifest.capabilities ?? [],
    generation: slot.generation,
    state: slot.state,
    ...(slot.running?.pid === undefined ? {} : { pid: slot.running.pid }),
    ...(problem === undefined ? {} : { problem }),
    ignoredFields: registration?.ignored ?? [],
    rejectedViews: registration?.rejectedViews ?? [],
    settings: registration?.manifest.settings ?? [],
    settingValues: slot.settingValues,
    provides: (registration?.manifest.provides ?? []).map((service) => ({
      name: service.name,
      methods: service.methods.map(({ name, title, description, readOnly, agent }) => ({
        name,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(agent === undefined ? {} : { agent }),
      })),
    })),
    waitingFor: slot.waitingFor,
  };
};

/** While the host switch is off nothing is parsed, so only the registered count is known. */
export const buildSnapshot = (input: {
  readonly slots: ReadonlyMap<unknown, Slot>;
  readonly hostEnabled: boolean;
  readonly claims: (slot: Slot) => boolean;
}): PluginHostSnapshot => {
  const active = input.hostEnabled ? [...input.slots.values()] : [];
  return {
    hostEnabled: input.hostEnabled,
    registered: input.slots.size,
    services: input.hostEnabled
      ? [...serviceOwners(input.slots.values(), input.claims)].map(([name, provider]) => ({
          name,
          provider: provider.id,
          available: serviceAvailable(provider),
        }))
      : [],
    plugins: active.map(entryOf),
    views: active.flatMap((slot) =>
      slot.views.map((view) => ({ ...view, generation: slot.generation })),
    ),
    commands: active.flatMap((slot) => slot.commands),
  };
};
