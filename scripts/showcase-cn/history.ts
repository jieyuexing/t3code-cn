// @effect-diagnostics nodeBuiltinImport:off - 演示仓的提交历史在录制前同步写进本机临时目录。
// 演示仓的提交历史：多位虚构作者、功能分支与合并，让「Git 日志」的分支图好看。
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type HistoryOp =
  | {
      readonly commit: string;
      readonly by: string;
      readonly at: string;
      /** 相对仓根的文件与内容；空对象表示提交工作区里已有的全部文件。 */
      readonly files?: Readonly<Record<string, string>>;
    }
  | { readonly branch: string }
  | { readonly checkout: string }
  | { readonly merge: string; readonly by: string; readonly at: string; readonly message: string };

/** 在已 `git init` 的目录里按顺序执行；结束时停在 `main`。 */
export function applyHistory(dir: string, ops: ReadonlyArray<HistoryOp>) {
  const git = (env: Record<string, string>, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env } });
  const who = (by: string, at: string) => ({
    GIT_AUTHOR_NAME: by,
    GIT_AUTHOR_EMAIL: `${by.split(" ")[0]!.toLowerCase()}@example.invalid`,
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_NAME: by,
    GIT_COMMITTER_EMAIL: `${by.split(" ")[0]!.toLowerCase()}@example.invalid`,
    GIT_COMMITTER_DATE: at,
  });
  for (const op of ops) {
    if ("branch" in op) git({}, "checkout", "-q", "-b", op.branch);
    else if ("checkout" in op) git({}, "checkout", "-q", op.checkout);
    else if ("merge" in op) {
      git(who(op.by, op.at), "merge", "-q", "--no-ff", "-m", op.message, op.merge);
    } else {
      for (const [file, content] of Object.entries(op.files ?? {})) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, file), content);
      }
      git({}, "add", "--all");
      git(who(op.by, op.at), "commit", "-q", "--allow-empty", "-m", op.commit);
    }
  }
  git({}, "checkout", "-q", "main");
}
