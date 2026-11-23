import { NeedsYouGtd, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { usePluginHostCall } from "../usePluginHost";
import { GTD_DUE_DAYS, GTD_RECENT_DAYS } from "./needsYouGtd.logic";

const CACHE_MS = 60_000;
const decode = Schema.decodeUnknownOption(NeedsYouGtd);
// The last read per project, kept for the session so reopening the popup within a minute asks nothing.
const cache = new Map<string, { readonly at: number; readonly gtd: NeedsYouGtd }>();

/**
 * The GTD digest of the project at `cwd`, read when the popup that uses this hook opens and again only on
 * `refresh` or after a minute. There is no polling; a failed read leaves the digest out, so the popup
 * looks the way it did without it.
 */
export function useNeedsYouGtd(environmentId: EnvironmentId, cwd: string) {
  const call = usePluginHostCall(environmentId);
  const key = `${environmentId}\n${cwd}`;
  const [gtd, setGtd] = useState<NeedsYouGtd | null>(() => cache.get(key)?.gtd ?? null);
  const [loading, setLoading] = useState(false);

  const load = useStableCallback(async (force: boolean) => {
    const cached = cache.get(key);
    if (!force && cached !== undefined && Date.now() - cached.at < CACHE_MS) return;
    setLoading(true);
    const result = await call({
      _tag: "needsYouGtd",
      cwd,
      dueDays: GTD_DUE_DAYS,
      recentDays: GTD_RECENT_DAYS,
    });
    setLoading(false);
    if (result._tag !== "Success") return;
    const next = decode(result.value.value);
    if (Option.isNone(next)) return;
    cache.set(key, { at: Date.now(), gtd: next.value });
    setGtd(next.value);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the digest from the server when the popup opens
  useEffect(() => {
    void load(false);
  }, [load]);
  return { gtd, loading, refresh: () => void load(true) };
}
