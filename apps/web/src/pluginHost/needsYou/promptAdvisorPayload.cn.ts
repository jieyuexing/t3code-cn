/** Wire format shared with apps/server/src/textGeneration/promptAdvisor.cn.ts. */
export const PROMPT_ADVISOR_PREFIX = "\u001et3cn-advisor:v1:";

export type PromptAdvisorKind = "challenge" | "next" | "angle";

export interface PromptAdvisorItem {
  readonly kind: PromptAdvisorKind;
  /** The button caption. */
  readonly label: string;
  /** What lands in the composer. */
  readonly fill: string;
}

const KINDS: ReadonlyArray<string> = ["challenge", "next", "angle"];
const MAX_ITEMS = 3;

/** Whether `raw` is an encoded advisor payload, which must never show as grey text. */
export function isPromptAdvisorPayload(raw: string | null): raw is string {
  return raw?.startsWith(PROMPT_ADVISOR_PREFIX) === true;
}

function isItem(value: unknown): value is PromptAdvisorItem {
  if (typeof value !== "object" || value === null) return false;
  const { kind, label, fill } = value as Record<string, unknown>;
  return (
    typeof kind === "string" &&
    KINDS.includes(kind) &&
    typeof label === "string" &&
    label.trim() !== "" &&
    typeof fill === "string" &&
    fill.trim() !== ""
  );
}

/** The payload's items, an empty list for a damaged one, and null for an ordinary suggestion. */
export function parsePromptAdvisorPayload(
  raw: string | null,
): ReadonlyArray<PromptAdvisorItem> | null {
  if (!isPromptAdvisorPayload(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(PROMPT_ADVISOR_PREFIX.length));
    const items =
      typeof parsed === "object" && parsed !== null ? (parsed as { items?: unknown }).items : [];
    return Array.isArray(items) ? items.filter(isItem).slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}
