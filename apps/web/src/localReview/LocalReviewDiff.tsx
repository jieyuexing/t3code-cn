import { FileDiff } from "@pierre/diffs/react";
import type { EnvironmentId, LocalReviewCommit, LocalReviewFile } from "@t3tools/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import { DIFF_VIEW_UNSAFE_CSS } from "../components/diffs/StyledDiffCodeView";
import { useRenderedAppearance } from "../hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { fileDiffTargets, shortHash, type FileDiffTarget } from "./localReview.logic";

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

function TargetDiff({
  environmentId,
  file,
  target,
}: {
  environmentId: EnvironmentId;
  file: LocalReviewFile;
  target: FileDiffTarget;
}) {
  const sourceKind = target.kind === "commit" ? ("commit" as const) : ("working-tree" as const);
  const query = useEnvironmentQuery(
    reviewEnvironment.diffFilePatch({
      environmentId,
      input: {
        request: {
          cwd: file.repo,
          ...(target.kind === "commit"
            ? { commitSha: target.hash }
            : { sourceKind: "working-tree" as const }),
          file: { path: file.path, previousPath: null, sourceKind },
        },
        cacheKey: `local-review:${file.repo}:${file.path}:${target.kind === "commit" ? target.hash : "working-tree"}`,
      },
    }),
  );
  return (
    <section className="overflow-hidden rounded-md border border-border/60">
      <h3 className="flex items-baseline gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs">
        {target.kind === "commit" ? (
          <>
            <span className="font-mono text-muted-foreground">提交 {shortHash(target.hash)}</span>
            <span className="min-w-0 truncate">{target.subject}</span>
          </>
        ) : (
          <span className="font-medium">现仍未提交</span>
        )}
      </h3>
      {query.data !== null ? (
        <PatchView patch={query.data.diff} />
      ) : query.error !== null ? (
        <p className="px-3 py-2 text-xs text-destructive">{query.error}</p>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">正在读取差异…</p>
      )}
    </section>
  );
}

export function LocalReviewDiff({
  environmentId,
  file,
  commits,
}: {
  environmentId: EnvironmentId;
  file: LocalReviewFile;
  commits: ReadonlyArray<LocalReviewCommit>;
}) {
  const targets = fileDiffTargets(file, commits);
  if (targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        这个文件没有可显示的提交，也不在未提交改动里。
      </p>
    );
  }
  return (
    <DiffWorkerPoolProvider>
      <div className="flex flex-col gap-3">
        {targets.map((target) => (
          <TargetDiff
            key={target.kind === "commit" ? target.hash : "working-tree"}
            environmentId={environmentId}
            file={file}
            target={target}
          />
        ))}
      </div>
    </DiffWorkerPoolProvider>
  );
}
