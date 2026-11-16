import type {
  LocalReviewBlindSpot,
  LocalReviewCommit,
  LocalReviewFile,
  LocalReviewRequestHead,
  LocalReviewSourceLayer,
} from "@t3tools/contracts";

export const LOCAL_REVIEW_DAYS = 7;

const SOURCE_LABELS: Readonly<Record<LocalReviewSourceLayer, string>> = {
  checkpoint: "总仓快照",
  fileChange: "编辑记录",
  output: "本次提交",
  range: "合并带入",
  child: "子会话",
};

export const SOURCE_HINTS: Readonly<Record<LocalReviewSourceLayer, string>> = {
  checkpoint: "每轮结束时对总仓工作区拍的快照里有这个文件；快照可能也含同一时刻别的线程的改动。",
  fileChange: "这一请求里用编辑工具（Edit／Write）改过这个文件。",
  output: "这一请求里用 git 命令做出的提交改了这个文件。",
  range: "这一请求里的合并、拉取或推送带进来的提交改了这个文件，不一定是这个请求自己写的。",
  child: "这个文件是这一请求派出的子会话改的。",
};

export const SOURCE_LAYERS: ReadonlyArray<LocalReviewSourceLayer> = [
  "checkpoint",
  "fileChange",
  "output",
  "range",
  "child",
];

export const EMPTY_LIST_TEXT = `近 ${LOCAL_REVIEW_DAYS} 天没有识别到改动的请求。已识别的范围见“统计范围”；只用脚本改、没提交的嵌套仓文件不在内。`;
export const EMPTY_REQUEST_TEXT = "这一请求没有识别到文件改动。";

export const SOURCE_LEGEND_TITLE = "文件右侧的来源标签（悬停可看说明）";

export const SCOPE_NOTES: ReadonlyArray<string> = [
  "只改不提交、又不是用编辑工具（Edit／Write）改的嵌套仓文件看不到；“编辑记录”只含编辑工具改过的文件。",
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

export const sourceLabel = (source: LocalReviewSourceLayer) => SOURCE_LABELS[source];

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

export interface RequestGroup {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requests: ReadonlyArray<LocalReviewRequestHead>;
}

/** Threads ordered by their latest request, each thread's requests newest first. */
export function groupRequestsByThread(
  requests: ReadonlyArray<LocalReviewRequestHead>,
): ReadonlyArray<RequestGroup> {
  const byThread = new Map<string, LocalReviewRequestHead[]>();
  for (const request of requests) {
    byThread.set(request.threadId, [...(byThread.get(request.threadId) ?? []), request]);
  }
  return [...byThread.values()]
    .map((grouped) => {
      const sorted = grouped.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
      return {
        threadId: sorted[0]!.threadId,
        threadTitle: sorted[0]!.threadTitle,
        requests: sorted,
      };
    })
    .toSorted((a, b) => b.requests[0]!.startedAt.localeCompare(a.requests[0]!.startedAt));
}

const MINUTE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `MM-DD HH:mm` in local time. */
export function formatRequestTime(iso: string): string {
  const parts = Object.fromEntries(
    MINUTE_FORMAT.formatToParts(Date.parse(iso)).map((part) => [part.type, part.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function requestHeadline(head: LocalReviewRequestHead): string {
  const text = head.requestTitle === "" ? "（没有文字的请求）" : head.requestTitle;
  return head.origin === "agent" ? `Agent 发起 · ${text}` : text;
}
