import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  loadSessionSpriteLedger,
  type PromptAdvisorOutcome,
  triggerSessionSpriteScan,
} from "./promptAdvisorConfigClient";
import type {
  SessionSpriteLedgerPayload,
  SessionSpriteScanResult,
} from "./promptAdvisorConfig.logic";

const settleLedger = (
  loading: Promise<PromptAdvisorOutcome<SessionSpriteLedgerPayload>>,
  setLedger: (ledger: SessionSpriteLedgerPayload) => void,
  setError: (message: string | null) => void,
  setLoading: (loading: boolean) => void,
) =>
  loading.then(
    (outcome) => {
      setLoading(false);
      if (outcome.ok) {
        setLedger(outcome.value);
        setError(null);
      } else {
        setError(outcome.message);
      }
    },
    () => {
      setLoading(false);
    },
  );

/**
 * Loads the session sprite's shadow observation ledger once per environment (never polled)
 * and provides manual refresh and on-demand scan actions.
 */
export function useSessionSpriteLedger(environmentId: EnvironmentId) {
  const [ledger, setLedger] = useState<SessionSpriteLedgerPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScanResult, setLastScanResult] = useState<SessionSpriteScanResult | null>(null);
  const aborts = useRef(new Set<AbortController>());

  const track = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    const controller = new AbortController();
    aborts.current.add(controller);
    return run(controller.signal)
      .catch(() => null)
      .finally(() => aborts.current.delete(controller));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's shadow ledger, an external system, once per environment
  useEffect(() => {
    const controller = new AbortController();
    const pending = aborts.current;
    void settleLedger(
      loadSessionSpriteLedger(environmentId, controller.signal),
      setLedger,
      setError,
      setLoading,
    );
    return () => {
      controller.abort();
      for (const item of pending) item.abort();
    };
  }, [environmentId]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    aborts.current.add(controller);
    void settleLedger(
      loadSessionSpriteLedger(environmentId, controller.signal),
      setLedger,
      setError,
      setLoading,
    ).finally(() => aborts.current.delete(controller));
  };

  const scanNow = async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    const outcome = await track((signal) =>
      triggerSessionSpriteScan(environmentId, { bypassQuietHours: true, bypassIdle: true }, signal),
    );
    setScanning(false);
    if (outcome === null) return;
    if (outcome.ok) {
      const result = outcome.value;
      setLastScanResult(result);
      setLedger((current) => ({
        summary: result.summary,
        entries: result.entries,
        ledgerPath: current?.ledgerPath ?? "",
      }));
    } else {
      setError(outcome.message);
    }
  };

  return {
    ledger,
    loading,
    scanning,
    error,
    lastScanResult,
    refresh,
    scanNow,
  };
}
