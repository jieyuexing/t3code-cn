import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * The thread's recent window, the bounded snapshot the thread view itself opens with (a megabyte at
 * most), not the whole transcript. `unavailable` when the environment is not connected or the read failed.
 */
export const threadTail = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:needs-you:thread-tail",
  execute: Effect.fn("needsYou.threadTail")(function* (input: { readonly threadId: ThreadId }) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) return { _tag: "unavailable" as const };
    const loader = yield* ThreadSnapshotLoader;
    return yield* loader.load(prepared.value, input.threadId);
  }),
});
