import type { EnvironmentId, PluginHostSnapshot, RailConfig } from "@t3tools/contracts";
import { useState } from "react";

import { useCanCallPluginHost, usePluginHostAction, usePluginHostSnapshot } from "../usePluginHost";
import { railOf } from "./rail.logic";

/**
 * The environment's rail and a way to change it. A change shows at once and gives way to the server's
 * own copy as soon as a newer snapshot arrives; a refused save puts the old rail back.
 */
export function useRailConfig(environmentId: EnvironmentId): {
  readonly snapshot: PluginHostSnapshot | null;
  readonly config: RailConfig;
  readonly canEdit: boolean;
  readonly save: (next: RailConfig) => Promise<void>;
} {
  const { snapshot } = usePluginHostSnapshot(environmentId);
  const canEdit = useCanCallPluginHost(environmentId);
  const act = usePluginHostAction(environmentId);
  const [pending, setPending] = useState<{
    readonly base: RailConfig | undefined;
    readonly value: RailConfig;
  } | null>(null);
  const config =
    pending !== null && pending.base === snapshot?.rail ? pending.value : railOf(snapshot);
  const save = async (next: RailConfig) => {
    setPending({ base: snapshot?.rail, value: next });
    const result = await act(
      { _tag: "setRail", rail: next },
      { title: "Could not save the app rail" },
    );
    if (result._tag === "Failure") setPending(null);
  };
  return { snapshot, config, canEdit, save };
}
