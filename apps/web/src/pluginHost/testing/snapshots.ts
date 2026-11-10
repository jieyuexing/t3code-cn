import { PluginId, type PluginHostEntry, type PluginHostSnapshot } from "@t3tools/contracts";

type Method = PluginHostEntry["provides"][number]["methods"][number];

/** A plugin that provides one service, for tests of what the host draws from service declarations. */
export function providerEntry(
  id: string,
  name: string,
  service: string,
  methods: ReadonlyArray<Method>,
  overrides: Partial<PluginHostEntry> = {},
): PluginHostEntry {
  return {
    id: PluginId.make(id),
    name,
    version: "0.1.0",
    directory: `/plugins/${id}`,
    enabled: true,
    consent: "granted",
    digest: "3f9a0000c21e0000",
    capabilities: [],
    generation: 1,
    state: { _tag: "standby" },
    ignoredFields: [],
    rejectedViews: [],
    settings: [],
    settingValues: {},
    provides: [{ name: service, methods }],
    waitingFor: [],
    ...overrides,
  };
}

/** A snapshot whose services list the given providers; `available: false` lists a service that cannot be called now. */
export function servicesSnapshot(
  providers: ReadonlyArray<{ readonly entry: PluginHostEntry; readonly available?: boolean }>,
  listed = true,
): PluginHostSnapshot {
  return {
    hostEnabled: true,
    registered: providers.length,
    plugins: providers.map(({ entry }) => entry),
    views: [],
    services: listed
      ? providers.flatMap(({ entry, available }) =>
          entry.provides.map((service) => ({
            name: service.name,
            provider: entry.id,
            available: available ?? true,
          })),
        )
      : [],
  };
}

export const GREET: Method = {
  name: "greet",
  title: "Greet",
  description: "Greets by name.",
  readOnly: true,
  ui: true,
  input: {
    type: "object",
    properties: { name: { type: "string", description: "Who to greet." } },
    required: ["name"],
  },
};
export const NOW: Method = {
  name: "now",
  title: "Current time",
  readOnly: true,
  ui: true,
  input: { type: "object", properties: { label: { type: "string" } } },
};
