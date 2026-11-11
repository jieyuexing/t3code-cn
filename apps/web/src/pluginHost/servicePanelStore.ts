import { create } from "zustand";

import type { FieldError, FormValues } from "./serviceForm";

export interface MethodDraft {
  readonly values: FormValues | null;
  readonly open: boolean;
  /** Why the last attempt to call was refused, by field name. */
  readonly errors: Readonly<Record<string, FieldError>>;
  readonly result: { readonly kind: "ok" | "error"; readonly text: string } | null;
}

const EMPTY_DRAFT: MethodDraft = { values: null, open: false, errors: {}, result: null };

const panelKey = (environmentId: string, service: string) => `${environmentId}|${service}`;
export const methodKey = (environmentId: string, service: string, method: string) =>
  `${panelKey(environmentId, service)}|${method}`;

interface ServicePanelState {
  readonly drafts: Readonly<Record<string, MethodDraft>>;
  /** The method whose form should take focus the next time its panel is on screen. */
  readonly focusRequest: string | null;
  readonly patch: (key: string, change: Partial<MethodDraft>) => void;
  readonly requestFocus: (key: string) => void;
  readonly clearFocus: (key: string) => void;
}

/**
 * What was typed and returned in service panels. It lives in memory only: it must outlast the panel
 * component (a provider going away, a settings visit), and is dropped with the page.
 */
export const useServicePanelStore = create<ServicePanelState>((set) => ({
  drafts: {},
  focusRequest: null,
  patch: (key, change) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: { ...(state.drafts[key] ?? EMPTY_DRAFT), ...change } },
    })),
  requestFocus: (key) =>
    set((state) => ({
      focusRequest: key,
      drafts: { ...state.drafts, [key]: { ...(state.drafts[key] ?? EMPTY_DRAFT), open: true } },
    })),
  clearFocus: (key) =>
    set((state) => (state.focusRequest === key ? { focusRequest: null } : state)),
}));

export const draftOf = (drafts: Readonly<Record<string, MethodDraft>>, key: string): MethodDraft =>
  drafts[key] ?? EMPTY_DRAFT;
