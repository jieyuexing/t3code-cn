import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const localReviewEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:local-review:list",
    tag: WS_METHODS.localReviewList,
    staleTimeMs: 15_000,
  }),
  get: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:local-review:get",
    tag: WS_METHODS.localReviewGet,
    staleTimeMs: 30_000,
  }),
};
