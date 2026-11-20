import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { ShareChoices } from "./usageShareModel";

const STORAGE_KEY = "t3code:usage-share-rows:v1";
const ShareChoicesSchema = Schema.Record(Schema.String, Schema.Boolean);

/** Storage that is missing or unreadable means the default rules apply. */
export function readShareChoices(): ShareChoices {
  try {
    return getLocalStorageItem(STORAGE_KEY, ShareChoicesSchema) ?? {};
  } catch (error) {
    console.error("Could not read the share image row choices.", error);
    return {};
  }
}

export function saveShareChoices(choices: ShareChoices): void {
  try {
    setLocalStorageItem(STORAGE_KEY, choices, ShareChoicesSchema);
  } catch (error) {
    console.error("Could not save the share image row choices.", error);
  }
}
