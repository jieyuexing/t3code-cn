import { useEffect, useEffectEvent, useState } from "react";

import type { InlineCodeProbe } from "./inlineCodeMissing.cn";

const NONE: ReadonlySet<string> = new Set();

/**
 * The inline code spans confirmed to name no file, to render as plain code instead of a chip.
 * Verdicts only accumulate within a scope, so a span never flips back to a chip while text streams;
 * a file created after the check shows as a chip again once the message remounts.
 */
export function useMissingInlineCode({
  scope,
  enabled,
  probes,
  confirm,
}: {
  readonly scope: string;
  readonly enabled: boolean;
  readonly probes: ReadonlyArray<InlineCodeProbe>;
  readonly confirm: (probes: ReadonlyArray<InlineCodeProbe>) => Promise<ReadonlySet<string>>;
}): ReadonlySet<string> {
  const [verdict, setVerdict] = useState({ scope, missing: NONE });
  const known = verdict.scope === scope ? verdict.missing : NONE;
  const probesKey = JSON.stringify(probes);
  const confirmProbes = useEffectEvent(confirm);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Asks the environment whether paths exist; the result is dropped once the scope or the paths change.
  useEffect(() => {
    const pending = (JSON.parse(probesKey) as InlineCodeProbe[]).filter(
      (probe) => !known.has(probe.text),
    );
    if (!enabled || pending.length === 0) return;
    let current = true;
    void confirmProbes(pending).then(
      (missing) => {
        if (!current || missing.size === 0) return;
        setVerdict((previous) => ({
          scope,
          missing: new Set([...(previous.scope === scope ? previous.missing : NONE), ...missing]),
        }));
      },
      () => {
        // An unanswered check leaves the chip as it is.
      },
    );
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `known` only filters out spans already confirmed; a new verdict must not rerun the check.
  }, [enabled, scope, probesKey]);
  return known;
}
