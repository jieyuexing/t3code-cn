import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";
import type { EnvironmentId, PluginId, ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { BridgeCallError } from "./bridge";
import { openThreadDiff } from "./diffNavigation";
import { createHostApi } from "./hostApi";
import { pendingThreads } from "./pendingThreads";
import { pluginSettingsKey, requestPluginSettings } from "./pluginSettingsStore";
import { pluginHostEnvironment } from "./state";

function unwrap<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw new BridgeCallError({
    code: isAtomCommandInterrupted(result) ? "cancelled" : "call-failed",
    message: error instanceof Error ? error.message : "The request failed.",
  });
}

/** What a view's `callHost` runs: the environment's read-only Git calls, the thread's diff panel, the thread list, replies and snoozing, and the caller's own settings page. */
export function useHostApi(options: {
  readonly environmentId: EnvironmentId;
  /** The plugin whose view calls; it is the only plugin whose settings the view can open. */
  readonly pluginId: PluginId;
  readonly capabilities: ReadonlyArray<string>;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { environmentId, pluginId, capabilities, threadRef } = options;
  const navigate = useNavigate();
  const quietly = { reportFailure: false };
  const status = useAtomCommand(pluginHostEnvironment.vcsStatus, quietly);
  const preview = useAtomCommand(pluginHostEnvironment.diffPreview, quietly);
  const fileContents = useAtomCommand(pluginHostEnvironment.diffFileContents, quietly);
  const transcript = useAtomCommand(orchestrationEnvironment.threadTranscript, quietly);
  const snooze = useOrchestrationCommand(threadEnvironment.snooze, quietly);
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
    openPluginSettings: () => {
      requestPluginSettings(pluginSettingsKey(environmentId, pluginId));
      void navigate({ to: "/settings/plugins", search: { machine: environmentId } });
    },
    // Read when called, so a view's polling does not re-render the panel on every thread update.
    pendingThreads: () =>
      pendingThreads({
        shells: appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom),
        environmentId,
        projectNames: new Map(
          appAtomRegistry
            .get(environmentProjects.projectsAtom)
            .filter((project) => project.environmentId === environmentId)
            .map((project) => [project.id, project.title]),
        ),
        // oxlint-disable-next-line react/purity -- runs when the view calls, not during render (oxc#27309)
        now: new Date().toISOString(),
      }),
    lastReply: async (threadId) => {
      const { items } = unwrap(
        await transcript({ environmentId, input: { threadId: ThreadId.make(threadId) } }),
      );
      for (const { item } of items.toReversed()) {
        if (item.type === "assistant_message") return item.text;
      }
      return "";
    },
    openThread: (threadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: ThreadId.make(threadId) }),
      });
    },
    snoozeThread: async (threadId, until) => {
      unwrap(
        await snooze({
          environmentId,
          input: { threadId: ThreadId.make(threadId), snoozedUntil: until },
        }),
      );
    },
  });
}
