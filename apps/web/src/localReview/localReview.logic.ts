import type {
  LocalReviewBlindSpot,
  LocalReviewCommit,
  LocalReviewFile,
  LocalReviewSourceLayer,
} from "@t3tools/contracts";

export const LOCAL_REVIEW_DAYS = 7;

const SOURCE_LABELS: Readonly<Record<LocalReviewSourceLayer, string>> = {
  checkpoint: "检查点",
  fileChange: "文件改动",
  output: "产出",
  range: "范围",
  child: "子会话",
};

export const EMPTY_LIST_TEXT = `近 ${LOCAL_REVIEW_DAYS} 天没有识别到改动的请求。已识别的范围见“统计范围”；只用脚本改、没提交的嵌套仓文件不在内。`;
export const EMPTY_REQUEST_TEXT = "这一请求没有识别到文件改动。";

export const SCOPE_NOTES: ReadonlyArray<string> = [
  "只改不提交且不是用 Edit／Write 改的嵌套仓文件看不到。",
  "命令输出超过 1 MiB 时，尾部的提交号可能缺。",
  "脚本里调用 git、而命令本身不含提交类动词的提交看不到。",
  "别的线程恰在某条提交类命令执行期间（带钩子可长达数十秒）在同一个仓里提交的，可能算进来。",
  "“现仍未提交”“现已提交到”是现在的状态，不是当时的。",
];

export const BLIND_SPOT_LABELS: Readonly<Record<LocalReviewBlindSpot, string>> = {
  "output-truncated": "有命令输出被截断",
  "git-budget": "部分仓没有探测",
};

export interface RepoGroup {
  readonly repo: string;
  readonly name: string;
  readonly files: ReadonlyArray<LocalReviewFile>;
}

const repoName = (repo: string) => repo.slice(repo.lastIndexOf("/") + 1);

export function groupFilesByRepo(files: ReadonlyArray<LocalReviewFile>): ReadonlyArray<RepoGroup> {
  const byRepo = new Map<string, LocalReviewFile[]>();
  for (const file of files) byRepo.set(file.repo, [...(byRepo.get(file.repo) ?? []), file]);
  return [...byRepo]
    .map(([repo, grouped]) => ({
      repo,
      name: repoName(repo),
      files: grouped.toSorted((a, b) => a.path.localeCompare(b.path)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export const shortHash = (hash: string) => hash.slice(0, 7);

export function describeFileState(file: LocalReviewFile): string | null {
  if (file.state.kind === "uncommitted") return "现仍未提交";
  if (file.state.kind === "committed") return `现已提交到 ${shortHash(file.state.hash)}`;
  return null;
}

export function describeSources(file: LocalReviewFile): string {
  return file.sources.map((source) => SOURCE_LABELS[source]).join("、");
}

export type FileDiffTarget =
  | { readonly kind: "commit"; readonly hash: string; readonly subject: string }
  | { readonly kind: "working-tree" };

export function fileDiffTargets(
  file: LocalReviewFile,
  commits: ReadonlyArray<LocalReviewCommit>,
): ReadonlyArray<FileDiffTarget> {
  const known = new Map(commits.map((commit) => [commit.hash, commit]));
  const targets: FileDiffTarget[] = file.commits
    .map((hash) => known.get(hash))
    .filter((commit) => commit !== undefined)
    .toSorted((a, b) => a.time - b.time)
    .map((commit) => ({ kind: "commit" as const, hash: commit.hash, subject: commit.subject }));
  if (file.state.kind === "uncommitted") targets.push({ kind: "working-tree" });
  return targets;
}

export function commitsOfRepo(commits: ReadonlyArray<LocalReviewCommit>, repo: string) {
  return commits.filter((commit) => commit.repo === repo).toSorted((a, b) => a.time - b.time);
}
