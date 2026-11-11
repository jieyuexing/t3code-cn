// Calls into plugin services: from another plugin or one of its views, from the interface and from an agent.
// Every source takes the same way to the provider and differs only in who the provider sees and what it may call.
import type { PluginHostError, PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { Json } from "./PluginIpc.ts";
import { ServiceCallInput, serviceHandler } from "./PluginIpc.ts";
import type { PluginRegistration } from "./PluginManifestLoader.ts";
import type { PluginProcess } from "./PluginProcess.ts";
import { serviceOwners } from "./PluginReconcile.ts";
import {
  fail,
  injectedServices,
  providedServices,
  serviceAvailable,
  type Slot,
} from "./PluginSlot.ts";

const decodeServiceCall = Schema.decodeUnknownEffect(ServiceCallInput);

/** Who the provider sees as the caller of an agent or of the interface; neither is a valid plugin name. */
const AGENT_CALLER = "t3:agent";
const USER_CALLER = "t3:user";

/** A service method an agent may call. */
export interface AgentServiceMethod {
  readonly service: string;
  readonly method: string;
  readonly provider: PluginId;
  readonly title?: string;
  readonly description?: string;
  readonly readOnly: boolean;
  /** The declared JSON Schema for the input. */
  readonly input?: Json;
}

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasJsonType = (value: Json, type: Json | undefined) => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
};

/**
 * The top level of the input against the method's JSON Schema: its own type, the required
 * fields and the types of the fields it names. The plugin checks the rest.
 */
const inputProblem = (schema: Json | undefined, input: Json): string | undefined => {
  if (!isObject(schema)) return undefined;
  if (!hasJsonType(input, schema.type)) return `The input must be of type ${String(schema.type)}.`;
  if (!isObject(input)) return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.find((name) => typeof name === "string" && !(name in input));
  if (missing !== undefined) return `The input is missing the field ${String(missing)}.`;
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const [name, property] of Object.entries(properties)) {
    const value = input[name];
    if (value !== undefined && isObject(property) && !hasJsonType(value, property.type))
      return `The field ${name} must be of type ${String(property.type)}.`;
  }
  return undefined;
};

export interface ServiceCallDependencies {
  readonly slots: () => Iterable<Slot>;
  readonly hostEnabled: () => boolean;
  /** Plugins that want to run; only these provide services. */
  readonly claims: (slot: Slot) => boolean;
  readonly ensureRunning: (
    slot: Slot,
  ) => Effect.Effect<
    { readonly process: PluginProcess; readonly registration: PluginRegistration },
    PluginHostError
  >;
}

interface ServiceRequest {
  readonly service: string;
  readonly method: string;
  readonly input: Json;
}

const failureText = (error: PluginHostError) => error.detail ?? error.reason;

export const makeServiceCalls = (dependencies: ServiceCallDependencies) => {
  const { slots, hostEnabled, claims, ensureRunning } = dependencies;
  const owners = () => serviceOwners(slots(), claims);

  /** Why a service has no available provider, with what its provider waits for. */
  const unavailable = (service: string) => {
    const declaring = [...slots()].find((slot) => providedServices(slot).includes(service));
    if (declaring === undefined)
      return fail("not-found", `No plugin provides the service ${service}.`);
    const state = declaring.state;
    const why = !declaring.enabled
      ? "is not enabled"
      : declaring.consent !== "granted"
        ? "needs consent again"
        : state._tag === "waiting"
          ? `is waiting for ${declaring.waitingFor.join(", ")}`
          : state._tag === "quarantined"
            ? `is quarantined: ${state.reason}`
            : (declaring.problem ?? declaring.conflict ?? "is not active");
    return fail("not-running", `${declaring.id} provides ${service} but ${why}.`);
  };

  /** The available provider of a service and the method it declares, if it does. */
  const reach = Effect.fn("PluginServiceCall.reach")(function* (service: string, method: string) {
    const provider = owners().get(service);
    if (provider === undefined || !serviceAvailable(provider)) return yield* unavailable(service);
    const declared = provider.registration?.manifest.provides
      .find((candidate) => candidate.name === service)
      ?.methods.find((candidate) => candidate.name === method);
    return { provider, declared };
  });

  /** Starts the provider if it is not running and invokes the method; a call error carries the provider's own text. */
  const forward = Effect.fn("PluginServiceCall.forward")(function* (
    provider: Slot,
    request: ServiceRequest,
    caller: string,
  ) {
    const { process } = yield* ensureRunning(provider);
    return yield* process
      .invoke(serviceHandler(request.service, request.method), { input: request.input, caller })
      .pipe(
        Effect.mapError((error) =>
          fail(
            "call-failed",
            error.detail === undefined ? error.reason : `${error.reason}: ${error.detail}`,
          ),
        ),
      );
  });

  /** Names the service and its provider, so the caller can tell whose error it is. */
  const withOrigin = (service: string, provider: Slot) => (error: PluginHostError) =>
    fail(error.reason, `${service} (${provider.id}): ${failureText(error)}`);

  /** Forwards a call from `caller` to a service method, after checking everything the host can check. */
  const callFromPlugin = Effect.fn("PluginServiceCall.fromPlugin")(function* (
    caller: Slot,
    input: Json,
  ) {
    const request = yield* decodeServiceCall(input).pipe(
      Effect.mapError(() => "The request needs a service, a method and an input."),
    );
    const { service, method } = request;
    if (!injectedServices(caller).includes(service))
      return yield* Effect.fail(`Plugin ${caller.id} does not declare a dependency on ${service}.`);
    const { provider, declared } = yield* reach(service, method).pipe(Effect.mapError(failureText));
    if (declared === undefined)
      return yield* Effect.fail(`The service ${service} has no method ${method}.`);
    return yield* forward(provider, request, caller.id).pipe(
      Effect.mapError((error) => failureText(withOrigin(service, provider)(error))),
    );
  });

  /** The same call, made by a view of `caller` on its behalf; the view sees only what the plugin injects. */
  const callFromView = Effect.fn("PluginServiceCall.fromView")(function* (
    caller: Slot,
    request: ServiceRequest,
  ) {
    if (caller.offer === undefined)
      return yield* fail("not-running", `${caller.id} does not offer views right now.`);
    const { service, method } = request;
    if (!injectedServices(caller).includes(service))
      return yield* fail(
        "not-found",
        `Plugin ${caller.id} does not declare a dependency on ${service}.`,
      );
    const { provider, declared } = yield* reach(service, method);
    if (declared === undefined)
      return yield* fail("not-found", `The service ${service} has no method ${method}.`);
    return yield* forward(provider, request, caller.id).pipe(
      Effect.mapError(withOrigin(service, provider)),
    );
  });

  /** The methods an agent may call now: marked `agent` in the manifest, on an available service. */
  const agentMethods = Effect.sync((): ReadonlyArray<AgentServiceMethod> => {
    if (!hostEnabled()) return [];
    return [...owners()].flatMap(([service, provider]) =>
      !serviceAvailable(provider)
        ? []
        : (provider.registration?.manifest.provides
            .find((declared) => declared.name === service)
            ?.methods.filter((method) => method.agent === true)
            .map((method) => ({
              service,
              method: method.name,
              provider: provider.id,
              ...(method.title === undefined ? {} : { title: method.title }),
              ...(method.description === undefined ? {} : { description: method.description }),
              readOnly: method.readOnly === true,
              ...(method.input === undefined ? {} : { input: method.input }),
            })) ?? []),
    );
  });

  const callFromAgent = Effect.fn("PluginServiceCall.fromAgent")(function* (
    request: ServiceRequest,
  ) {
    if (!hostEnabled()) return yield* fail("host-disabled");
    const { provider, declared } = yield* reach(request.service, request.method);
    if (declared === undefined || declared.agent !== true)
      return yield* fail(
        "not-found",
        `${request.service}.${request.method} is not a method agents may call.`,
      );
    const problem = inputProblem(declared.input, request.input);
    if (problem !== undefined) return yield* fail("invalid-input", problem);
    return yield* forward(provider, request, AGENT_CALLER);
  });

  /** A method the interface offers: marked `ui` in the manifest, on an available service. */
  const callFromUi = Effect.fn("PluginServiceCall.fromUi")(function* (request: ServiceRequest) {
    if (!hostEnabled()) return yield* fail("host-disabled");
    const { provider, declared } = yield* reach(request.service, request.method);
    if (declared === undefined || declared.ui !== true)
      return yield* fail(
        "not-found",
        `${request.service}.${request.method} is not a method the interface offers.`,
      );
    return yield* forward(provider, request, USER_CALLER).pipe(
      Effect.mapError(withOrigin(request.service, provider)),
    );
  });

  return { callFromPlugin, callFromView, callFromUi, agentMethods, callFromAgent };
};
