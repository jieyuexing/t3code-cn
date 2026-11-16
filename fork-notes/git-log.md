# Git 日志页（只读）

左下角侧栏入口「Git」点开 `/pull-requests?source=git`：一个带分支图的提交日志，上半是提交列表，下半是选中提交的文件清单，点文件才在下面展开差异。页头「Git 日志 ｜ 拉取请求」切换，切到拉取请求就是上游原来的 PR 页（不带 `source`）。界面照 `t3-tortoise` 插件的日志页（分支图算法 `graph.ts` 与它的测试从那里搬来）。不写任何东西，git 只用只读命令；文件清单与差异复用已有的 `review.getDiffPreview`／`review.diffFilePatch`。

## 现行结构

- 合同：`packages/contracts/src/gitLog.ts`，一个只读调用 `gitLog.list`。入参：可选 `repo`（仓绝对路径，必须是发现到的仓；缺省取最近更新的项目根里的第一个仓）、`limit`（默认 100，上限 2000）、`query`（筛选词）。结果：`repos`（全部发现的仓）、`repo`（本次读的仓）、`commits`（哈希、父提交、说明、作者、提交时间、指向它的分支／标签名）、`hasMore`。
- 服务端 `apps/server/src/gitLog/`：
  - `gitFacts.ts`：仓库发现（从各项目的 `workspace_root` 起，跳过 `node_modules`、`.local`、`.state`、`dist`、`target`，深度 ≤7，至多 100 个仓，同层按名字排序）；`readLog` 用 `git log --topo-order`（父提交一定排在子提交之后，分支图要求这个顺序）。筛选词不分大小写，匹配说明、作者、哈希，或改动路径含该词的提交（另跑一次 `git log -- :(icase)*词*` 取路径命中，上限 5000 条）；筛选时分批扫（每批 500，最多 20000 条）。直接用 `node:child_process`，没走 Effect 进程层（文件头 `@effect-diagnostics nodeBuiltinImport:off globalDate:off`），原因是它是纯异步函数，测试不需要 Effect 运行时；上游若要求统一，改在 `GitLogService.ts` 里注入。
  - `GitLogService.ts`：Effect 包装，读 `projection_projects` 取项目根，仓发现结果缓存 30 秒（并发请求共用）。
- 网页 `apps/web/src/gitLog/`：`GitLogPage.tsx`（页面：仓下拉、筛选框、刷新；上半提交列表，列为 分支图｜时间 MM-DD HH:mm｜作者｜说明，分支／标签名作小标签；下半「作者 · 时间 · 说明」、文件清单（状态字母 A/M/D/R 与增删数）、选中文件的差异）、`GitLogFileDiff.tsx`（`review.diffFilePatch` 加自带 `FileDiff`，统一／并排用 T3 自带的客户端设置 `diffLayout`）、`GitLogGraphCell.tsx`（一行的 SVG 分支图）、`graph.ts`（泳道算法，纯函数，带 `graph.test.ts`）、`GitLogSourceSwitch.tsx`、`GitLogRoute.tsx`（`source !== "git"` 时回到原 `PullRequestsPage`）、`gitLog.logic.ts`、`gitLogState.ts`。
- 翻页：把 `limit` 加 100 整段重取（服务端每次从头读），页面在加载期间保留上一页；滚到底（距底 80px 内）或点「加载更早…」触发。分支图只在没有筛选词时画：筛选后的历史不连续，连线没有意义。
- 合并提交的文件清单按第一父提交比较（`review.getDiffPreview` 的既有行为），差异区标注。
- 公司仓（`projects/etech` 下）照常列出。差异读取受 `ReviewService` 的目录白名单限制：只有项目根之内的仓能看差异，仓发现正是从项目根起，所以一致。
- 默认仓是「当前项目」所在仓，实现上取最近更新的项目根里发现的第一个仓；页面不在某个线程里，没有“当前线程”可取。

Agent 与移动端：不接 MCP 工具、不做移动端界面；`WS_METHODS` 新增一项对移动端无影响。

## 上游文件改动（相对上游 `67343edb9f`）

共 31 行插入、6 行改行（`packages/contracts/src/gitLog.ts` 是 fork 自有新文件，不算）：

| 文件                                                            | 插入           | 挂的是什么                                                                                  |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                                 | 9              | 导入、方法名、RPC 定义、并入 RPC 组                                                         |
| `packages/contracts/src/index.ts`                               | 1              | 导出                                                                                        |
| `apps/server/src/ws.ts`                                         | 3              | 取服务、处理器                                                                              |
| `apps/server/src/server.ts`                                     | 2              | 层组装                                                                                      |
| `apps/server/src/auth/RpcAuthorization.ts`                      | 1              | 方法鉴权（读文件系统）                                                                      |
| `apps/server/src/observability/RpcInstrumentation.ts`           | 1              | 观测表                                                                                      |
| `apps/server/src/ws.test.ts`、`pluginHost/PluginHostWs.test.ts` | 2＋2           | 测试替身                                                                                    |
| `apps/web/src/routes/_chat.pull-requests.tsx`                   | 3（另改 2 行） | 搜索参数 `source`，页面换成路由包装                                                         |
| `apps/web/src/components/pullRequest/usePullRequestListView.ts` | 1              | 搜索类型                                                                                    |
| `apps/web/src/components/pullRequest/PullRequestsColumn.tsx`    | 2              | 页头挂来源切换                                                                              |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`             | 4（另改 4 行） | 侧栏入口改成「Git」（图标、文字）并带 `source: "git"`；删掉不再用的 `PullRequestGlyph` 导入 |

## 同步上游时

`rpc.ts`、`ws.ts`、`server.ts` 的挂载行冲突按插入点重挂；路由包装 `PullRequestsRoute` 若上游改了 PR 页路由，保持 `source !== "git"` 时回到原 `PullRequestsPage`；侧栏入口若上游改了 `handlePullRequestsClick`，保持带 `source: "git"`。命令面板的 “Open pull requests” 与“重开已关闭视图”仍进 PR 页（不带 `source`），没有改。
