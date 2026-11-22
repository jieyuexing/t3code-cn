// The plugin side of the host for plugin tests: `context.settings`, `context.storage`, `context.cache` and
// `context.services` as the host serves them to the child process, with the host's own limits and
// sentences (`packages/contracts/src/pluginHost/hostRules.ts`). Loaded by plugin repos with plain Node:
// relative imports with `.ts`, erasable TypeScript only, nothing from `effect` or `@t3tools/*`.
import {
  cacheEntryBytes,
  cacheEvictions,
  cacheValueProblem,
  methodWrites,
  missingMethodProblem,
  pluginErrorText,
  pluginKey,
  serviceOrigin,
  storageValueProblem,
  type CacheUsed,
} from "../../../../../packages/contracts/src/pluginHost/hostRules.ts";

type Run = (input: unknown, meta: { readonly caller: string }) => unknown;

/** A plugin that provides a service in the test: its id and the methods it declares. */
export interface ServiceProvider {
  readonly plugin: string;
  readonly methods: Readonly<Record<string, { readonly readOnly?: boolean; readonly run: Run }>>;
}

export interface PluginContextOptions {
  readonly pluginId: string;
  /** The capabilities in the plugin's manifest; `storage` and `settings` exist only with `settings`. */
  readonly capabilities: ReadonlyArray<string>;
  /** The settings the manifest declares, with their values; any other key is unknown. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** The services the manifest injects: `context.services` has exactly these, as in the child process. */
  readonly inject?: ReadonlyArray<string>;
  /** The providers of services, by service name. */
  readonly providers?: Readonly<Record<string, ServiceProvider>>;
  /** Smaller cache limits, to reach them without writing megabytes. */
  readonly cacheLimits?: { readonly maxBytes?: number; readonly maxValueBytes?: number };
}

/** What crosses the host's IPC: JSON only, so `undefined` fields and functions are gone. */
const overIpc = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

export function createPluginContext(options: PluginContextOptions) {
  const { pluginId, capabilities } = options;
  const storage = new Map<string, unknown>();
  const cache = new Map<string, CacheUsed & { readonly value: unknown }>();
  const dataRevisions = new Map<string, number>();
  let clock = 0;

  const keyOf = (input: unknown): string => {
    const key = (input as { readonly key?: unknown } | null)?.key;
    if (typeof key !== "string") throw new Error("The request needs a key.");
    return pluginKey(key);
  };

  const settings = {
    get: async (key: string) => {
      const declared = keyOf({ key });
      if (!Object.hasOwn(options.settings ?? {}, declared)) {
        throw new Error(`Unknown setting ${declared}.`);
      }
      return overIpc(options.settings?.[declared]);
    },
  };

  const storageApi = {
    get: async (key: string) => overIpc(storage.get(keyOf({ key }))),
    set: async (key: string, value: unknown) => {
      const name = keyOf({ key });
      const stored = overIpc(value);
      const tooLarge = storageValueProblem(stored);
      if (tooLarge !== undefined) throw new Error(tooLarge);
      storage.set(name, stored);
      return null;
    },
  };

  const cacheApi = {
    get: async (key: string) => {
      const name = keyOf({ key });
      const used = cache.get(name);
      if (used === undefined) return null;
      cache.set(name, { ...used, order: ++clock });
      return overIpc(used.value);
    },
    set: async (key: string, value: unknown) => {
      const name = keyOf({ key });
      const stored = overIpc(value);
      const bytes = cacheEntryBytes(name, stored);
      const tooLarge = cacheValueProblem(bytes, options.cacheLimits?.maxValueBytes);
      if (tooLarge !== undefined) throw new Error(tooLarge);
      cache.set(name, { bytes, order: ++clock, value: stored });
      for (const oldest of cacheEvictions(cache, name, options.cacheLimits?.maxBytes)) {
        cache.delete(oldest);
      }
      return null;
    },
    delete: async (key: string) => {
      cache.delete(keyOf({ key }));
      return null;
    },
  };

  const callService = async (service: string, method: string, input: unknown) => {
    const provider = options.providers?.[service];
    if (provider === undefined) throw new Error(`No plugin provides the service ${service}.`);
    const declared = Object.hasOwn(provider.methods, method) ? provider.methods[method] : undefined;
    if (declared === undefined) throw new Error(missingMethodProblem(service, method));
    let result: unknown;
    try {
      result = await declared.run(overIpc(input), { caller: pluginId });
    } catch (error) {
      throw new Error(
        serviceOrigin(service, provider.plugin, `failed: ${pluginErrorText(error)}`),
        {
          cause: error,
        },
      );
    }
    if (methodWrites(declared)) {
      dataRevisions.set(provider.plugin, (dataRevisions.get(provider.plugin) ?? 0) + 1);
    }
    return overIpc(result);
  };

  const services = Object.fromEntries(
    (options.inject ?? []).map((service) => [
      service,
      new Proxy(
        {},
        {
          get: (_target, method) =>
            typeof method === "string" && method !== "then"
              ? (input?: unknown) => callService(service, method, input ?? null)
              : undefined,
        },
      ),
    ]),
  );

  return {
    /** What the plugin's `activate` receives, apart from `log`, `handle` and `provide`. */
    context: {
      pluginId,
      cache: cacheApi,
      services,
      ...(capabilities.includes("settings") ? { settings, storage: storageApi } : {}),
    },
    /** How often a call to a method not declared `readOnly` succeeded on this plugin's services. */
    dataRevision: (provider: string) => dataRevisions.get(provider) ?? 0,
    /** The keys held in storage and cache, oldest cache entry first. */
    storageKeys: () => [...storage.keys()],
    cacheKeys: () =>
      [...cache].toSorted((left, right) => left[1].order - right[1].order).map(([key]) => key),
  };
}
