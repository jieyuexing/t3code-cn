import { BERTH_COUNT, emptyBerths, type Berths } from "./berths.logic";

const storageKey = (environmentId: string) => `t3code:berths:${environmentId}`;

export function parseBerths(raw: string | null): Berths {
  if (raw === null) return emptyBerths();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== BERTH_COUNT) return emptyBerths();
    const seen = new Set<string>();
    return parsed.map((entry) => {
      if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) return null;
      seen.add(entry);
      return entry;
    });
  } catch {
    return emptyBerths();
  }
}

export function readBerths(environmentId: string): Berths {
  try {
    return parseBerths(localStorage.getItem(storageKey(environmentId)));
  } catch {
    return emptyBerths();
  }
}

export function writeBerths(environmentId: string, berths: Berths): void {
  try {
    localStorage.setItem(storageKey(environmentId), JSON.stringify(berths));
  } catch {
    // Storage may be unavailable in restricted contexts; in-memory berths still hold.
  }
}
