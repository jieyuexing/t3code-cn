import { FILESYSTEM_METADATA_BATCH_LIMIT } from "@t3tools/contracts";
import {
  pickProjectLinkMatch,
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
  /** Other projects of the same environment, searched as a click does. */
  readonly otherRoots: ReadonlyArray<string>;
  /** One entry per path, null when it does not exist; null for the whole call when unanswered. */
  readonly stat: (paths: string[]) => Promise<ReadonlyArray<unknown> | null>;
  /** Null when the search failed. */
  readonly search: (root: string, query: string) => Promise<InlineCodeSearchResult | null>;
}

/**
 * The inline code spans whose file chip would open nothing: the literal path does not exist and the
 * search a click runs finds no file either. Anything unanswered, truncated, or over budget is
 * unknown and left out, so its chip stays.
 */
export async function confirmMissingInlineCodePaths(
  probes: ReadonlyArray<InlineCodeProbe>,
  deps: InlineCodeMissingDeps,
): Promise<Set<string>> {
  const { cwd, otherRoots } = deps;
  const candidates = probes
    .flatMap((probe) => {
      const target = statTarget(probe.path, cwd);
      return target === null ? [] : [{ ...probe, target }];
    })
    .slice(0, FILESYSTEM_METADATA_BATCH_LIMIT);
  const missing = new Set<string>();
  if (candidates.length === 0) return missing;

  const entries = await deps.stat(candidates.map((candidate) => candidate.target));
  if (entries === null) return missing;
  const unconfirmed = candidates.filter((_, index) => entries[index] === null);

  let budget = INLINE_CODE_SEARCH_BUDGET;
  const roots = [cwd, ...otherRoots];
  const searched = await Promise.all(
    unconfirmed.map(async ({ text, path }) => {
      if (workspaceLinkLookupQuery(path, cwd) === null) return text;
      if (budget < roots.length) return null;
      budget -= roots.length;
      const results = await Promise.all(
        roots.map(async (root) => {
          const query = workspaceLinkLookupQuery(path, root);
          const result =
            query === null ? { entries: [], truncated: false } : await deps.search(root, query);
          return { root, result };
        }),
      );
      const answered = results.flatMap(({ root, result }) =>
        result === null || result.truncated ? [] : [{ root, entries: result.entries }],
      );
      if (answered.length < roots.length) return null;
      const [own, ...others] = answered;
      const found =
        pickWorkspaceLinkMatch(path, cwd, own!.entries) ?? pickProjectLinkMatch(path, others);
      return found === null ? text : null;
    }),
  );
  for (const text of searched) if (text !== null) missing.add(text);
  return missing;
}

function statTarget(path: string, cwd: string): string | null {
  if (isAbsolutePath(path) || path.startsWith("~/") || path.startsWith("~\\")) return null;
  const target = resolveWorkspaceFilePath(path, cwd);
  // A network path leaks the Windows user's credentials to its host once a server stats it.
  return target.length <= STAT_PATH_MAX_LENGTH && !isNetworkPath(target) ? target : null;
}
