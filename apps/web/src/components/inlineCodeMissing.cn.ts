import { FILESYSTEM_METADATA_BATCH_LIMIT } from "@t3tools/contracts";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceLinkMatch,
  workspaceLinkLookupQuery,
  type WorkspaceEntryCandidate,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { isAbsolutePath, isNetworkPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";

// Mirrors the filesystem RPC's path length cap; one over-long path would fail the whole batch.
const STAT_PATH_MAX_LENGTH = 512;

/** Search requests one message may spend; paths past it stay unknown and keep their chip. */
export const INLINE_CODE_SEARCH_BUDGET = 12;

export interface InlineCodeProbe {
  /** The inline code span as written; the key of the verdict. */
  readonly text: string;
  /** The workspace-relative path the chip would open. */
  readonly path: string;
}

export interface InlineCodeSearchResult {
  readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
  readonly truncated: boolean;
}

export interface InlineCodeMissingDeps {
  readonly cwd: string;
  /** Folders the agent worked in besides `cwd`; a click opens a path there as written. */
  readonly agentRoots: ReadonlyArray<string>;
  /** One entry per path, null when it does not exist; null for the whole call when unanswered. */
  readonly stat: (paths: string[]) => Promise<ReadonlyArray<unknown> | null>;
  /** Null when the search failed. */
  readonly search: (root: string, query: string) => Promise<InlineCodeSearchResult | null>;
}

/**
 * The inline code spans that name no file of the thread's own project: the literal path is missing
 * there and in every folder the agent worked in, and the project search finds no match. Another
 * project's file with the same suffix does not count. Anything unanswered, truncated, or over
 * budget is unknown and left out, so its chip stays.
 */
export async function confirmMissingInlineCodePaths(
  probes: ReadonlyArray<InlineCodeProbe>,
  deps: InlineCodeMissingDeps,
): Promise<Set<string>> {
  const { cwd, agentRoots } = deps;
  const candidates: Array<InlineCodeProbe & { readonly targets: string[] }> = [];
  let statCount = 0;
  for (const probe of probes) {
    // A bare file name is searched for in the agent's folders on click; leave that to the click.
    if (agentRoots.length > 0 && needsWorkspaceBasenameLookup(probe.path)) continue;
    const roots = [cwd, ...agentRoots];
    const targets = roots.flatMap((root) => statTarget(probe.path, root) ?? []);
    if (targets.length < roots.length) continue;
    if (statCount + targets.length > FILESYSTEM_METADATA_BATCH_LIMIT) break;
    statCount += targets.length;
    candidates.push({ ...probe, targets });
  }
  const missing = new Set<string>();
  if (candidates.length === 0) return missing;

  const entries = await deps.stat(candidates.flatMap((candidate) => candidate.targets));
  if (entries === null) return missing;
  let offset = 0;
  const unconfirmed = candidates.filter((candidate) => {
    const absent = candidate.targets.every((_, index) => entries[offset + index] === null);
    offset += candidate.targets.length;
    return absent;
  });

  let budget = INLINE_CODE_SEARCH_BUDGET;
  const searched = await Promise.all(
    unconfirmed.map(async ({ text, path }) => {
      const query = workspaceLinkLookupQuery(path, cwd);
      if (query === null) return text;
      if (budget === 0) return null;
      budget -= 1;
      const result = await deps.search(cwd, query);
      if (result === null || result.truncated) return null;
      return pickWorkspaceLinkMatch(path, cwd, result.entries) === null ? text : null;
    }),
  );
  for (const text of searched) if (text !== null) missing.add(text);
  return missing;
}

function statTarget(path: string, root: string): string | null {
  if (isAbsolutePath(path) || path.startsWith("~/") || path.startsWith("~\\")) return null;
  const target = resolveWorkspaceFilePath(path, root);
  // A network path leaks the Windows user's credentials to its host once a server stats it.
  return target.length <= STAT_PATH_MAX_LENGTH && !isNetworkPath(target) ? target : null;
}
