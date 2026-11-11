import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { useAtomCommand } from "../state/use-atom-command";
import { BridgeCallError } from "./bridge";
import { openThreadDiff } from "./diffNavigation";
import { createHostApi } from "./hostApi";
import { pluginHostEnvironment } from "./state";

function unwrap<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw new BridgeCallError({
    code: isAtomCommandInterrupted(result) ? "cancelled" : "call-failed",
    message: error instanceof Error ? error.message : "The request failed.",
  });
}

/** What a view's `callHost` runs: the environment's read-only Git calls, and the thread's diff panel. */
export function useHostApi(options: {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlyArray<string>;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { environmentId, capabilities, threadRef } = options;
  const quietly = { reportFailure: false };
  const status = useAtomCommand(pluginHostEnvironment.vcsStatus, quietly);
  const preview = useAtomCommand(pluginHostEnvironment.diffPreview, quietly);
  const fileContents = useAtomCommand(pluginHostEnvironment.diffFileContents, quietly);
  return createHostApi({
    capabilities,
    // `localOnly` keeps this from fetching or reading the remote status.
    status: async ({ cwd }) =>
      unwrap(await status({ environmentId, input: { cwd, localOnly: true } })),
    preview: async (input) => unwrap(await preview({ environmentId, input })),
    fileContents: async (input) => unwrap(await fileContents({ environmentId, input })),
    openDiff: (target) => {
      if (threadRef === null) {
        throw new BridgeCallError({ code: "call-failed", message: "No thread is open." });
      }
      openThreadDiff(threadRef, target);
    },
  });
}
