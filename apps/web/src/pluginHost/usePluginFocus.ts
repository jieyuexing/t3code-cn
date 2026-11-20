import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useProjectFileQuery } from "../components/files/projectFilesQueryState";
import type { PluginFocus } from "./bridge";
import { focusPathOf, useFocusSurface } from "./focusSurface";

/**
 * The file or folder the thread's file panel last stood on, with its kind. A file tab may hold a
 * folder, which only the server's read tells; until it does the answer is the one given before, or
 * `undefined` when there is none, so a page is never told a guess.
 */
export function usePluginFocus(
  environmentId: EnvironmentId,
  threadRef: ScopedThreadRef | null,
  cwd: string | null,
): PluginFocus | null | undefined {
  const surface = useFocusSurface(threadRef);
  const target = surface === null || cwd === null ? null : focusPathOf(surface, cwd);
  const file = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    target?.relativePath ?? null,
    target?.relativePath != null,
  );
  const unresolved =
    target?.relativePath != null && file.isPending && file.data === null && file.readError === null;
  const resolved: PluginFocus | null =
    target === null
      ? null
      : {
          path: target.path,
          kind: target.relativePath === null || file.isNotFile ? "folder" : "file",
        };
  const encoded = JSON.stringify(resolved);
  // The last settled answer, kept by adjusting state while rendering, stands in while the next tab is read.
  const [held, setHeld] = useState<string | undefined>(undefined);
  if (!unresolved && held !== encoded) setHeld(encoded);
  if (!unresolved) return resolved;
  return held === undefined ? undefined : (JSON.parse(held) as PluginFocus | null);
}
