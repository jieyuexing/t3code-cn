import type { PluginHostEntry, PluginHostSnapshot, PluginId } from "@t3tools/contracts";

/** The prefix of a service panel's `viewId`; a plugin's own view ids never contain a colon. */
const SERVICE_VIEW_PREFIX = "service:";

export const serviceViewId = (service: string) => `${SERVICE_VIEW_PREFIX}${service}`;

/** The service a panel's `viewId` names, or `null` for an ordinary plugin view. */
export function serviceOfViewId(viewId: string): string | null {
  return viewId.startsWith(SERVICE_VIEW_PREFIX) ? viewId.slice(SERVICE_VIEW_PREFIX.length) : null;
}

type DeclaredMethod = PluginHostEntry["provides"][number]["methods"][number];

export interface UiMethod {
  readonly service: string;
  readonly provider: PluginHostEntry;
  readonly method: DeclaredMethod;
  /** Shown in the palette and as the method's heading. */
  readonly title: string;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a call must be given something to run. A schema that is not an object, or an object
 * with required fields, needs input; a method with no schema, or only optional fields, does not.
 */
export function methodNeedsInput(method: DeclaredMethod): boolean {
  const schema = method.input;
  if (!isObject(schema)) return false;
  if (typeof schema.type === "string" && schema.type !== "object") return true;
  return Array.isArray(schema.required) && schema.required.length > 0;
}

/** What a call without a form sends: nothing, or an empty object for a method that takes optional fields. */
export function emptyInput(method: DeclaredMethod): Record<string, never> | null {
  return isObject(method.input) ? {} : null;
}

/**
 * The service and what it declares for the interface. A service is available only while the
 * snapshot's `services` lists it with `available`; the methods come from the provider's
 * declaration, which stays in the snapshot while the plugin is off.
 */
export function serviceUi(
  snapshot: PluginHostSnapshot,
  service: string,
  providerId?: PluginId,
): {
  readonly provider: PluginHostEntry;
  readonly available: boolean;
  readonly methods: ReadonlyArray<UiMethod>;
  readonly declared: boolean;
} | null {
  const listed = snapshot.services.find(
    (candidate) =>
      candidate.name === service && (providerId === undefined || candidate.provider === providerId),
  );
  const provider = snapshot.plugins.find((plugin) =>
    listed === undefined
      ? (providerId === undefined || plugin.id === providerId) &&
        plugin.provides.some((declared) => declared.name === service)
      : plugin.id === listed.provider,
  );
  if (provider === undefined) return null;
  const declaration = provider.provides.find((declared) => declared.name === service);
  return {
    provider,
    available: listed?.available === true,
    declared: declaration !== undefined,
    methods: (declaration?.methods ?? [])
      .filter((method) => method.ui === true)
      .map((method) => ({
        service,
        provider,
        method,
        title: method.title ?? `${service}.${method.name}`,
      })),
  };
}

/** Every method the interface offers right now, in the order the services are listed. */
export function availableUiMethods(snapshot: PluginHostSnapshot): ReadonlyArray<UiMethod> {
  return snapshot.services.flatMap((listed) =>
    listed.available ? (serviceUi(snapshot, listed.name, listed.provider)?.methods ?? []) : [],
  );
}
