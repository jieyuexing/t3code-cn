import type {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import { BridgeCallError } from "./bridge";

const VCS_READ_CAPABILITY = "host.vcs-read";

export interface DiffTarget {
  readonly kind: "working-tree" | "commit";
  readonly sha?: string;
  readonly file?: string;
}

export interface HostApiDeps {
  readonly capabilities: ReadonlyArray<string>;
  /** The local Git status, read without fetching. */
  readonly status: (input: { readonly cwd: string }) => Promise<unknown>;
  readonly preview: (input: ReviewDiffPreviewInput) => Promise<ReviewDiffPreviewResult>;
  readonly fileContents: (
    input: ReviewDiffFileContentsInput,
  ) => Promise<ReviewDiffFileContentsResult>;
  readonly openDiff: (target: DiffTarget) => void;
}

const denied = (message: string) => new BridgeCallError({ code: "denied", message });
const invalid = (message: string) => new BridgeCallError({ code: "invalid", message });

const readObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("The input must be an object.");
  }
  return value as Record<string, unknown>;
};

const readText = (input: Readonly<Record<string, unknown>>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw invalid(`"${key}" must be text.`);
  return value;
};

const readOptionalText = (input: Readonly<Record<string, unknown>>, key: string) =>
  input[key] === undefined || input[key] === null ? undefined : readText(input, key);

/** The comparison a call names: the working tree, or one commit that needs its sha. */
function readSource(input: Readonly<Record<string, unknown>>, key: "sourceKind" | "kind") {
  const kind = input[key];
  if (kind === "working-tree") return { kind } as const;
  if (kind === "commit")
    return { kind, sha: readText(input, key === "kind" ? "sha" : "commitSha") } as const;
  throw invalid(`"${key}" must be "working-tree" or "commit".`);
}

function readFile(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string")
    return { path: readText({ file: value }, "file"), previousPath: null };
  const file = readObject(value);
  return {
    path: readText(file, "path"),
    previousPath: readOptionalText(file, "previousPath") ?? null,
  };
}

function previewRequest(
  cwd: string,
  source: ReturnType<typeof readSource>,
  file: ReturnType<typeof readFile>,
): ReviewDiffPreviewInput {
  const target =
    source.kind === "commit" ? { commitSha: source.sha } : { sourceKind: "working-tree" as const };
  // Without a file, the list of changed files is the answer; a patch is read per file.
  return {
    cwd,
    ...target,
    ...(file === undefined
      ? { metadataOnly: true }
      : { file: { ...file, sourceKind: source.kind === "commit" ? "commit" : "working-tree" } }),
  };
}

/** What a file's patch says about how it changed, which the contents read needs. */
function changeOf(diff: string, path: string) {
  if (/^new file mode/m.test(diff)) return { changeType: "new", oldPath: path } as const;
  if (/^deleted file mode/m.test(diff)) return { changeType: "deleted", oldPath: path } as const;
  const renamedFrom = /^rename from (.+)$/m.exec(diff)?.[1];
  if (renamedFrom === undefined) return { changeType: "change", oldPath: path } as const;
  return {
    changeType: /^@@/m.test(diff) ? "rename-changed" : "rename-pure",
    oldPath: renamedFrom,
  } as const;
}

type Handler = (deps: HostApiDeps, input: Readonly<Record<string, unknown>>) => Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  "vcs.status": (deps, input) => deps.status({ cwd: readText(input, "cwd") }),
  "review.diffPreview": (deps, input) =>
    deps.preview(
      previewRequest(readText(input, "cwd"), readSource(input, "sourceKind"), readFile(input.file)),
    ),
  "review.diffFileContents": async (deps, input) => {
    const cwd = readText(input, "cwd");
    const source = readSource(input, "sourceKind");
    const file = readFile(input.file);
    if (file === undefined) throw invalid('"file" is required.');
    const preview = await deps.preview(previewRequest(cwd, source, file));
    const compared = preview.sources.find((candidate) => candidate.kind === source.kind);
    if (compared === undefined) {
      throw new BridgeCallError({
        code: "call-failed",
        message: "The comparison is no longer available.",
      });
    }
    return deps.fileContents({
      cwd,
      sourceKind: compared.kind,
      ...changeOf(compared.diff, file.path),
      baseRef: compared.baseRef,
      headRef: compared.headRef,
      newPath: file.path,
    });
  },
  "t3.openDiff": async (deps, input) => {
    const source = readSource(input, "kind");
    const file = readOptionalText(input, "file");
    deps.openDiff({
      kind: source.kind,
      ...(source.kind === "commit" ? { sha: source.sha } : {}),
      ...(file === undefined ? {} : { file }),
    });
    return null;
  },
};

/**
 * What a view's `callHost` reaches: a read-only slice of T3's Git, and the diff panel. A plugin
 * that did not declare `host.vcs-read` is denied everything, as is any method not listed here.
 */
export function createHostApi(deps: HostApiDeps) {
  return async (method: string, input: unknown): Promise<unknown> => {
    const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined;
    if (handler === undefined || !deps.capabilities.includes(VCS_READ_CAPABILITY)) {
      throw denied(
        handler === undefined
          ? `The host does not offer "${method}".`
          : `"${method}" needs the ${VCS_READ_CAPABILITY} capability.`,
      );
    }
    return handler(deps, readObject(input));
  };
}
