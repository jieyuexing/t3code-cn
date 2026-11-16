# PR 页「本地」页签（Git 履历，只读）

PR 页页头的来源切换（路由搜索参数 `source=local`）里的「本地」页：本机各仓当前 `HEAD` 的提交履历，选中提交看全部改动文件，点文件才展开差异。不写任何东西，git 只用只读命令（`log`、`status`）；差异与文件清单复用已有的 `review.getDiffPreview`。

## 现行结构

- 合同：`packages/contracts/src/localReview.ts`，一个只读调用 `localReview.log`。入参 `part`（`commits` 或 `dirty`）、可选 `repo`（仓绝对路径，必须是发现到的仓）、可选 `limit`（默认 50，上限 1000）；结果带全部发现仓 `repos`、`commits`、`dirty`、`hasMore`。提交和未提交改动分两次取，是因为大仓里扫未跟踪文件要 1–5 秒，不能拖住提交首屏。
- 服务端 `apps/server/src/localReview/`：
  - `gitFacts.ts`：仓库发现（从各项目的 `workspace_root` 起，跳过 `node_modules`、`.local`、`.state`、`dist`、`target`，深度 ≤7，至多 100 个仓）、各仓 `git log HEAD`、`git status`；git 并发上限 4。直接用 `node:child_process`，没走 Effect 进程层（文件头 `@effect-diagnostics nodeBuiltinImport:off`），原因是它是纯异步函数，测试不需要 Effect 运行时；上游若要求统一，改在 `LocalReviewService.ts` 里注入。
  - `LocalReviewService.ts`：Effect 包装，读 `projection_projects` 取项目根，仓发现结果缓存 30 秒。
- 提交列表：每个仓取 `limit+1` 条，按提交时间合并倒序后截 `limit` 条，多出来的说明还有下一页；「加载更多」把 `limit` 加 50 重取，页面在加载期间保留上一页。每行带标题、仓名（全部仓时）、短号、相对时间、作者、合并标记、指向该提交的分支／标签名。
- 未提交改动：`git status --untracked-files=normal` 的条目数（未跟踪目录算一项，列全部文件在大仓里要 5 秒以上），有改动的仓各一行置顶。
- 提交详情：说明正文、全号、作者、时间、父提交；文件清单与增删行数来自 `review.getDiffPreview`（`metadataOnly`，合并提交按第一父提交比较，未提交改动是工作区相对 `HEAD`，含未跟踪文件）；点文件展开 `review.diffFilePatch` 的差异，渲染用自带的 `FileDiff`。
- 网页 `apps/web/src/localReview/`：`LocalReviewPage.tsx`（页面）、`LocalReviewDiff.tsx`（单文件差异）、`LocalReviewSourceSwitch.tsx`（来源切换）、`LocalReviewRoute.tsx`（`source !== "local"` 时回到原 `PullRequestsPage`）、`localReview.logic.ts`、`localReviewState.ts`。公司仓（`projects/etech` 下）照常列出。
- 差异读取受 `ReviewService` 的目录白名单限制：只有项目根之内的仓能看差异，仓发现正是从项目根起，所以一致。

Agent 与移动端：不接 MCP 工具、不做移动端界面；`WS_METHODS` 新增一项对移动端无影响。

## 上游文件改动（只插入，相对合入「本地」页签之前的上游 `67343edb9f`）

共 27 行插入、2 行改行：

| 文件                                                            | 插入             | 挂的是什么                          |
| --------------------------------------------------------------- | ---------------- | ----------------------------------- |
| `packages/contracts/src/rpc.ts`                                 | 9                | 导入、方法名、RPC 定义、并入 RPC 组 |
| `packages/contracts/src/index.ts`                               | 1                | 导出                                |
| `apps/server/src/ws.ts`                                         | 3                | 取服务、处理器                      |
| `apps/server/src/server.ts`                                     | 2                | 层组装                              |
| `apps/server/src/auth/RpcAuthorization.ts`                      | 1                | 方法鉴权（读文件系统）              |
| `apps/server/src/observability/RpcInstrumentation.ts`           | 1                | 观测表                              |
| `apps/server/src/ws.test.ts`、`pluginHost/PluginHostWs.test.ts` | 2＋2             | 测试替身                            |
| `apps/web/src/routes/_chat.pull-requests.tsx`                   | 3（含 2 行改行） | 搜索参数 `source`，页面换成路由包装 |
| `apps/web/src/components/pullRequest/usePullRequestListView.ts` | 1                | 搜索类型                            |
| `apps/web/src/components/pullRequest/PullRequestsColumn.tsx`    | 2                | 页头挂来源切换                      |

## 同步上游时

`rpc.ts`、`ws.ts`、`server.ts` 的挂载行冲突按插入点重挂；路由包装 `PullRequestsRoute` 若上游改了 PR 页路由，保持 `source !== "local"` 时回到原 `PullRequestsPage`。
