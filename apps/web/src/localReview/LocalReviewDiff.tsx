import { FileDiff } from "@pierre/diffs/react";
import type { EnvironmentId } from "@t3tools/contracts";

import { DIFF_VIEW_UNSAFE_CSS } from "../components/diffs/StyledDiffCodeView";
import { useRenderedAppearance } from "../hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import type { Selection } from "./localReview.logic";

function PatchView({ patch }: { patch: string }) {
  const appearance = useRenderedAppearance();
  const renderable = getRenderablePatch(patch, "local-review");
  if (renderable === null)
    return <p className="px-3 py-2 text-xs text-muted-foreground">没有差异。</p>;
  if (renderable.kind === "raw") {
    return (
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs text-muted-foreground">
        {renderable.text}
      </pre>
    );
  }
  const options = {
    diffStyle: "unified" as const,
    lineDiffType: "none" as const,
    overflow: "scroll" as const,
    disableFileHeader: true,
    theme: resolveDiffThemeName(appearance),
    themeType: appearance,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
  };
  return (
    <>
      {renderable.files.map((file) => (
        <FileDiff key={file.cacheKey ?? file.name} fileDiff={file} options={options} />
      ))}
    </>
  );
}

export function LocalReviewFileDiff({
  environmentId,
  selection,
  path,
  previousPath,
}: {
  environmentId: EnvironmentId;
  selection: Selection;
  path: string;
  previousPath: string | null;
}) {
  const sourceKind = selection.kind === "commit" ? ("commit" as const) : ("working-tree" as const);
  const query = useEnvironmentQuery(
    reviewEnvironment.diffFilePatch({
      environmentId,
      input: {
        request: {
          cwd: selection.repo,
          ...(selection.kind === "commit"
            ? { commitSha: selection.hash }
            : { sourceKind: "working-tree" as const }),
          file: { path, previousPath, sourceKind },
        },
        cacheKey: `local-review:${selection.repo}:${path}:${selection.kind === "commit" ? selection.hash : "working-tree"}`,
      },
    }),
  );
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      {query.data !== null ? (
        <PatchView patch={query.data.diff} />
      ) : query.error !== null ? (
        <p className="px-3 py-2 text-xs text-destructive">{query.error}</p>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">正在读取差异…</p>
      )}
    </div>
  );
}
