import { WS_METHODS } from "@t3tools/contracts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPluginHostEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The environment's whole plugin picture; each frame replaces the last. */
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugin-host:snapshot",
      tag: WS_METHODS.pluginHostSubscribe,
      idleTtlMs: 0,
    }),
    call: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugin-host:call",
      tag: WS_METHODS.pluginHostCall,
    }),
  };
}
