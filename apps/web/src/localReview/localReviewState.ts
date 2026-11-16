import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const localReviewEnvironment = {
  log: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:local-review:log",
    tag: WS_METHODS.localReviewLog,
    staleTimeMs: 5_000,
  }),
};
