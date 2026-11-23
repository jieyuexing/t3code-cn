import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useProject, useThreadShell } from "~/state/entities";

/** The workspace root of the thread's project, or null while the thread or its project is not loaded. */
export function useThreadProjectCwd(threadRef: ScopedThreadRef): string | null {
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(threadRef.environmentId, shell.projectId),
  );
  return project?.workspaceRoot ?? null;
}
