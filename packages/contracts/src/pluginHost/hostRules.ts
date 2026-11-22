// The limits and checks the plugin host applies to what a plugin stores, caches, calls and throws. The host
// and `apps/web/src/pluginHost/testkit/` share them, so a plugin test fails with the host's own sentences.
// Nothing here may import: plugin repos load this file with plain Node, so it uses only erasable TypeScript.

/** One value in a plugin's `storage`, serialized. */
const PLUGIN_STORAGE_MAX_VALUE_BYTES = 256 * 1024;
/** Total a plugin's cache may hold. */
export const PLUGIN_CACHE_MAX_BYTES = 50 * 1024 * 1024;
/** One cached `{ key, value }` entry, serialized. */
export const PLUGIN_CACHE_MAX_VALUE_BYTES = 2 * 1024 * 1024;
/** Storage, settings and cache keys are cut to this many characters. */
const PLUGIN_KEY_MAX_CHARS = 128;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export const pluginKey = (key: string) => key.slice(0, PLUGIN_KEY_MAX_CHARS);

/** The sentence a plugin gets for a storage value over the limit, or `undefined` if it fits. */
export function storageValueProblem(value: unknown): string | undefined {
  return utf8Bytes(JSON.stringify(value)) > PLUGIN_STORAGE_MAX_VALUE_BYTES
    ? "The value is too large to store."
    : undefined;
}

const cacheEntryText = (key: string, value: unknown) => JSON.stringify({ key, value });

/** The sentence for a cache entry over the limit, or `undefined` if it fits. */
export function cacheValueProblem(
  entryBytes: number,
  maxValueBytes: number = PLUGIN_CACHE_MAX_VALUE_BYTES,
): string | undefined {
  return entryBytes > maxValueBytes ? "The value is too large to cache." : undefined;
}

/** The size of the `{ key, value }` entry the host writes; the cache limits count this, not the value alone. */
export const cacheEntryBytes = (key: string, value: unknown) =>
  utf8Bytes(cacheEntryText(key, value));

export interface CacheUsed {
  readonly bytes: number;
  /** Larger is more recent. */
  readonly order: number;
}

/** The entries dropped, least recently used first, until the cache fits `maxBytes`; `keep` is never one of them. */
export function cacheEvictions(
  index: ReadonlyMap<string, CacheUsed>,
  keep: string,
  maxBytes: number = PLUGIN_CACHE_MAX_BYTES,
): ReadonlyArray<string> {
  let total = 0;
  for (const used of index.values()) total += used.bytes;
  const evicted: Array<string> = [];
  for (const [name, used] of [...index].sort((left, right) => left[1].order - right[1].order)) {
    if (total <= maxBytes || name === keep) break;
    evicted.push(name);
    total -= used.bytes;
  }
  return evicted;
}

/** Why `pluginId` may not call `service`: it injects none of that name; `undefined` if it may. */
export function injectionProblem(
  pluginId: string,
  injected: ReadonlyArray<string>,
  service: string,
): string | undefined {
  return injected.includes(service)
    ? undefined
    : `Plugin ${pluginId} does not declare a dependency on ${service}.`;
}

export const missingMethodProblem = (service: string, method: string) =>
  `The service ${service} has no method ${method}.`;

/** A call to a method not declared `readOnly` moves the provider's data revision once it succeeds. */
export const methodWrites = (declared: { readonly readOnly?: boolean | undefined }) =>
  declared.readOnly !== true;

/** How a service call's error reads to its caller: the service and provider named before the provider's own text. */
export const serviceOrigin = (service: string, provider: string, text: string) =>
  `${service} (${provider}): ${text}`;

export const PLUGIN_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** The `code` of a thrown value when it is usable: 1–64 characters of `[A-Za-z0-9_.-]`; otherwise `undefined`. */
export function pluginErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && PLUGIN_ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

/** The text of a thrown value, cut to `max` characters: an `Error`'s message, an object's `message`, else `String`. */
export function pluginErrorText(error: unknown, max: number = 2000): string {
  const message =
    typeof error === "object" && error !== null
      ? (error as { readonly message?: unknown }).message
      : undefined;
  return (typeof message === "string" ? message : String(error)).slice(0, max);
}
