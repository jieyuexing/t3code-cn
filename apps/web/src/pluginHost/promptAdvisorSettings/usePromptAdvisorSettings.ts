import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  loadPromptAdvisorConfig,
  type PromptAdvisorOutcome,
  runPromptAdvisorTest,
  savePromptAdvisorConfig,
} from "./promptAdvisorConfigClient";
import {
  type PromptAdvisorConfig,
  type PromptAdvisorPayload,
  type PromptAdvisorTestRequest,
  type PromptAdvisorTestRun,
  type RuntimeRole,
  sameConfig,
} from "./promptAdvisorConfig.logic";

export type TestState =
  | { readonly phase: "idle" }
  | { readonly phase: "running" }
  | { readonly phase: "done"; readonly result: PromptAdvisorTestRun }
  | { readonly phase: "failed"; readonly message: string };

const IDLE: TestState = { phase: "idle" };

/** Applies a load's outcome; an abort leaves the page as it was. */
const settle = (
  loading: Promise<PromptAdvisorOutcome<PromptAdvisorPayload>>,
  setPayload: (payload: PromptAdvisorPayload) => void,
  setLoadError: (message: string | null) => void,
) =>
  loading.then(
    (outcome) => {
      if (outcome.ok) {
        setPayload(outcome.value);
        setLoadError(null);
      } else {
        setLoadError(outcome.message);
      }
    },
    () => {},
  );

/**
 * The server's advisor settings for one environment: loaded on mount and after a save, never
 * polled. Edits collect in a draft until saved; a test run can use the draft as it is.
 */
export function usePromptAdvisorSettings(environmentId: EnvironmentId) {
  const [payload, setPayload] = useState<PromptAdvisorPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<PromptAdvisorConfig | null>(null);
  const [tests, setTests] = useState<Readonly<Record<RuntimeRole, TestState>>>({
    advisor: IDLE,
    refiner: IDLE,
  });
  const aborts = useRef(new Set<AbortController>());

  const track = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    const controller = new AbortController();
    aborts.current.add(controller);
    return run(controller.signal)
      .catch(() => null)
      .finally(() => aborts.current.delete(controller));
  };

  const load = (signal: AbortSignal) =>
    settle(loadPromptAdvisorConfig(environmentId, signal), setPayload, setLoadError);
  const refresh = () => {
    const controller = new AbortController();
    aborts.current.add(controller);
    void load(controller.signal).finally(() => aborts.current.delete(controller));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's copy, an external system, once per environment
  useEffect(() => {
    const controller = new AbortController();
    void settle(
      loadPromptAdvisorConfig(environmentId, controller.signal),
      setPayload,
      setLoadError,
    );
    return () => controller.abort();
  }, [environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the requests still in flight when the page goes away
  useEffect(() => {
    const pending = aborts.current;
    return () => {
      for (const controller of pending) controller.abort();
    };
  }, []);

  const dirty = payload !== null && draft !== null && !sameConfig(draft, payload.config);
  const save = async () => {
    if (draft === null || saving) return;
    setSaving(true);
    const outcome = await track((signal) => savePromptAdvisorConfig(environmentId, draft, signal));
    setSaving(false);
    if (outcome === null) return;
    if (outcome.ok) {
      setPayload(outcome.value);
      setDraft(null);
      setSaveError(null);
    } else {
      setSaveError(outcome.message);
    }
  };
  const discard = () => {
    setDraft(null);
    setSaveError(null);
  };

  const runTest = async (request: PromptAdvisorTestRequest) => {
    const role = request.role;
    setTests((current) => ({ ...current, [role]: { phase: "running" } }));
    const outcome = await track((signal) => runPromptAdvisorTest(environmentId, request, signal));
    if (outcome === null) return;
    if (outcome.ok) {
      setTests((current) => ({ ...current, [role]: { phase: "done", result: outcome.value } }));
      setPayload((current) =>
        current === null ? current : { ...current, status: outcome.value.status },
      );
    } else {
      setTests((current) => ({
        ...current,
        [role]: { phase: "failed", message: outcome.message },
      }));
      const { status } = outcome;
      if (status !== undefined) {
        setPayload((current) => (current === null ? current : { ...current, status }));
      }
    }
  };

  return {
    payload,
    config: draft ?? payload?.config ?? null,
    dirty,
    loadError,
    saveError,
    saving,
    tests,
    edit: setDraft,
    save,
    discard,
    refresh,
    runTest,
  };
}
