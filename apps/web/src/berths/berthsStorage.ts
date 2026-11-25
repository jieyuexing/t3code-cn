import type { EnvironmentId } from "@t3tools/contracts";

import { BERTH_COUNT, emptyBerths, type Berths } from "./berths.logic";

const key = (environmentId: EnvironmentId) => `t3code:berths:${environmentId}`;

/** A broken record reads as six empty berths; a thread listed twice keeps its first slot. */
export function parseBerths(raw: string | null): Berths {
  let parsed: unknown;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return emptyBerths();
  }
  if (!Array.isArray(parsed) || parsed.length !== BERTH_COUNT) return emptyBerths();
  const seen = new Set<string>();
  return parsed.map((id) => {
    if (typeof id !== "string" || id === "" || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
}

export function readBerths(environmentId: EnvironmentId): Berths {
  try {
    return parseBerths(localStorage.getItem(key(environmentId)));
  } catch {
    return emptyBerths();
  }
}

export function writeBerths(environmentId: EnvironmentId, berths: Berths): void {
  try {
    localStorage.setItem(key(environmentId), JSON.stringify(berths));
  } catch {
    // Storage may be unavailable or full; the berths then last for this page view only.
  }
}
