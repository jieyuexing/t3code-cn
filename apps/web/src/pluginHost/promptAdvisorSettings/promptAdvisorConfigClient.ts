import type { EnvironmentId } from "@t3tools/contracts";
import { m } from "~/i18n/messages";

import { readAccess } from "../promptRefiner/promptRefinerClient";
import {
  configFailureMessage,
  PROMPT_ADVISOR_COPY,
  PROMPT_ADVISOR_PATHS,
  type PromptAdvisorConfig,
  type PromptAdvisorPath,
  type PromptAdvisorPayload,
  type PromptAdvisorStatus,
  type PromptAdvisorTestRequest,
  type PromptAdvisorTestRun,
  parsePromptAdvisorFailure,
  parsePromptAdvisorPayload,
  parsePromptAdvisorTestRun,
  promptAdvisorUrl,
} from "./promptAdvisorConfig.logic";

export type PromptAdvisorOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly message: string;
      /** The latest status a failed test run still reports. */
      readonly status?: PromptAdvisorStatus | undefined;
    };

const failed = (
  message: string,
  status?: PromptAdvisorStatus | undefined,
): PromptAdvisorOutcome<never> => ({ ok: false, message, status });

/** One call; an expired ticket is renewed once. Only an abort rejects. */
async function call<T>(
  environmentId: EnvironmentId,
  request: {
    readonly method: "GET" | "PUT" | "POST";
    readonly path: PromptAdvisorPath;
    readonly body?: unknown;
  },
  parse: (value: unknown) => T | null,
  signal: AbortSignal,
): Promise<PromptAdvisorOutcome<T>> {
  for (const renew of [false, true]) {
    const access = await readAccess(environmentId, renew);
    if (access === null) return failed(m(PROMPT_ADVISOR_COPY.notConnected));
    const response = await fetch(promptAdvisorUrl(access, request.path), {
      method: request.method,
      ...(request.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.body),
          }),
      credentials: access.credentials ? "include" : "same-origin",
      signal,
    }).catch((cause: unknown) => {
      if (signal.aborted) throw cause;
      return null;
    });
    if (response === null) return failed(m(PROMPT_ADVISOR_COPY.unreachable));
    if (response.status === 401 && !renew) continue;
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = parsePromptAdvisorFailure(json);
      return failed(failure.error ?? configFailureMessage(response.status), failure.status);
    }
    const value = parse(json);
    return value === null ? failed(m(PROMPT_ADVISOR_COPY.unrecognized)) : { ok: true, value };
  }
  return failed(configFailureMessage(401));
}

export const loadPromptAdvisorConfig = (
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<PromptAdvisorOutcome<PromptAdvisorPayload>> =>
  call(
    environmentId,
    { method: "GET", path: PROMPT_ADVISOR_PATHS.config },
    parsePromptAdvisorPayload,
    signal,
  );

export const savePromptAdvisorConfig = (
  environmentId: EnvironmentId,
  config: PromptAdvisorConfig,
  signal: AbortSignal,
): Promise<PromptAdvisorOutcome<PromptAdvisorPayload>> =>
  call(
    environmentId,
    { method: "PUT", path: PROMPT_ADVISOR_PATHS.config, body: { config } },
    parsePromptAdvisorPayload,
    signal,
  );

export const runPromptAdvisorTest = (
  environmentId: EnvironmentId,
  body: PromptAdvisorTestRequest,
  signal: AbortSignal,
): Promise<PromptAdvisorOutcome<PromptAdvisorTestRun>> =>
  call(
    environmentId,
    { method: "POST", path: PROMPT_ADVISOR_PATHS.testRun, body },
    parsePromptAdvisorTestRun,
    signal,
  );
