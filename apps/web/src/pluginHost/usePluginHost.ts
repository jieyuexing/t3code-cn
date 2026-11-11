import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  PluginHostError,
  type EnvironmentId,
  type PluginHostCallInput,
  type PluginHostSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";
import { pluginHostEnvironment } from "./state";

const isPluginHostError = Schema.is(PluginHostError);
const NO_SNAPSHOT = Atom.make(AsyncResult.initial<PluginHostSnapshot, never>());

/** The environment's plugin snapshot as it stands; `null` until the first frame arrives. */
export function usePluginHostSnapshot(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? NO_SNAPSHOT
      : pluginHostEnvironment.snapshot({ environmentId, input: {} }),
  );
  return {
    snapshot: AsyncResult.getOrElse(result, () => null),
    failed: AsyncResult.isFailure(result),
  };
}

/** Whether this connection may call the plugin host on the environment (the same grant as maintenance). */
export function useCanCallPluginHost(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(pluginHostEnvironment.call.permissionAtom(environmentId));
}

export function pluginHostFailureMessage(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "";
  const error = squashAtomCommandFailure(result);
  if (isPluginHostError(error)) return error.message;
  return error instanceof Error ? error.message : "The plugin host request failed.";
}

/** Runs one plugin host operation on the environment; failures come back in the result. */
export function usePluginHostCall(environmentId: EnvironmentId) {
  const run = useAtomCommand(pluginHostEnvironment.call, { reportFailure: false });
  return (input: PluginHostCallInput) => run({ environmentId, input });
}

/** Like `usePluginHostCall`, but a failure is shown as a toast titled by the action. */
export function usePluginHostAction(environmentId: EnvironmentId) {
  const call = usePluginHostCall(environmentId);
  return async (input: PluginHostCallInput, failure: { readonly title: string }) => {
    const result = await call(input);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failure.title,
        description: pluginHostFailureMessage(result),
      });
    }
    return result;
  };
}
