import type { Plugin } from "cordis";

export * from "cordis";

export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

export interface T3Context {
  readonly pluginId: string;
  readonly provides: ReadonlyArray<{
    readonly name: string;
    readonly methods: ReadonlyArray<string>;
  }>;
  readonly log: Record<"debug" | "info" | "warn" | "error", (...parts: Array<unknown>) => void>;
  readonly handle: (name: string, fn: (input: Json) => unknown) => void;
  readonly services: Readonly<
    Record<string, Readonly<Record<string, (input?: Json) => Promise<Json>>>>
  >;
  readonly provide: (
    name: string,
    methods: Readonly<Record<string, (input: Json, meta: { readonly caller: string }) => unknown>>,
  ) => void;
  /** Present when the manifest declares the `settings` capability. */
  readonly settings?: { readonly get: (key: string) => Promise<Json> };
  /** Present when the manifest declares the `settings` capability. */
  readonly storage?: {
    readonly get: (key: string) => Promise<Json>;
    readonly set: (key: string, value: Json) => Promise<Json>;
  };
}

declare module "cordis" {
  interface Context {
    /** The T3 plugin context; add `"t3"` to `inject` to use it. */
    t3: T3Context;
  }
}

export interface T3PluginEntry {
  activate(host: T3Context): Promise<void>;
  deactivate(): Promise<void>;
}

/** Wraps a Cordis plugin (a `Service` class or a plugin object) as a T3 plugin entry. */
export function cordisPlugin(plugin: Plugin, config?: unknown): T3PluginEntry;
