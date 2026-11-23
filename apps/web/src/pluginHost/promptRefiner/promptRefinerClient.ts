import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";

import {
  buildRefineRequest,
  parseRefineResponse,
  PROMPT_REFINE_BASE_PATH,
  type PromptRefineResult,
  refineFailureMessage,
  refineUrl,
} from "./promptRefiner.logic";

export type PromptRefineOutcome =
  | { readonly ok: true; readonly result: PromptRefineResult }
  | { readonly ok: false; readonly message: string };

const failed = (message: string): PromptRefineOutcome => ({ ok: false, message });

// The route authenticates like the device hub: a media ticket for bearer and DPoP connections,
// the session cookie otherwise.
const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: PROMPT_REFINE_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`prompt-refiner-access:${environmentId}`)),
);

function readAccess(
  environmentId: EnvironmentId,
  refresh: boolean,
): Promise<DeviceHubAccess | null> {
  const atom = accessAtom(environmentId);
  if (refresh) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

/** One refinement; an expired ticket is renewed once. Only an abort rejects. */
export async function requestPromptRefine(
  environmentId: EnvironmentId,
  input: Parameters<typeof buildRefineRequest>[0],
  signal: AbortSignal,
): Promise<PromptRefineOutcome> {
  const body = JSON.stringify(buildRefineRequest(input));
  for (const renew of [false, true]) {
    const access = await readAccess(environmentId, renew);
    if (access === null) return failed("尚未连接到环境，请稍后再试。");
    const response = await fetch(refineUrl(access), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: access.credentials ? "include" : "same-origin",
      body,
      signal,
    }).catch((cause: unknown) => {
      if (signal.aborted) throw cause;
      return null;
    });
    if (response === null) return failed("无法连接到服务器，请检查网络后重试。");
    if (response.status === 401 && !renew) continue;
    if (!response.ok) return failed(refineFailureMessage(response.status));
    const result = parseRefineResponse(await response.json().catch(() => null));
    return result === null ? failed("服务器返回了无法识别的结果。") : { ok: true, result };
  }
  return failed(refineFailureMessage(401));
}
