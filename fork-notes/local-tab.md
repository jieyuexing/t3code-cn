# PR 页「本地」页签（只读，第一期）

按一次请求看改了哪些文件，选中文件后再看差异。入口是 PR 页页头的来源切换（路由搜索参数 `source=local`）和线程详情卡里的「本线程的请求」行（带 `localThread`）；对话里的改动卡片与应用栏格子不做。不写任何东西，git 只用只读命令。

## 现行结构

- 合同：`packages/contracts/src/localReview.ts`，两个只读调用 `localReview.list`、`localReview.get`；差异不新增接口，复用 `review.getDiffPreview` 的 `diffFilePatch`。
- 服务端 `apps/server/src/localReview/`：`attribution.ts`（归属规则，纯函数，不引入 `effect`，回放脚本可直接导入）、`mentions.ts`、`gitFacts.ts`（只读 git 事实接口的真实实现）、`snapshot.ts`（读库快照，注入查询函数）、`requests.ts`（列表与单请求读取）、`LocalReviewService.ts`（Effect 包装、单请求缓存 128 条，键含各仓 HEAD，进行中的请求不缓存）。`gitFacts.ts` 与服务直接用 `node:child_process`、`node:os`，没走 Effect 进程层，原因是回放脚本要在没有 Effect 运行时的环境里驱动同一份代码；若上游要求统一，改在 `LocalReviewService.ts` 里注入。
- 网页 `apps/web/src/localReview/`：页面（左侧按线程分组、组内每次请求按首行与分钟时间倒序）、来源切换、差异、详情卡行；来源标签用直白词并带悬停说明——总仓快照（检查点）、编辑记录（`file_change`）、本次提交（命令做出的提交）、合并带入（`a..b` 范围）、子会话——页面脚注“统计范围”里同词解释；原子在 `localReviewState.ts`，直接用 `client-runtime` 的查询原子工厂，没有改 `client-runtime` 包。
- 列表只读库、不跑 git，每个请求带首行（该请求起点的用户消息，Agent 发起的由页面写明）；已完成轮与未变化子线程的粗信号在服务端内存里缓存（键含轮或线程的更新时间，上限 2 万条），暖启动约 30 ms、冷启动约 440 ms；单请求才跑 git，调用上限 150 次（超出标 `git-budget`），并发 4，文件显示上限 500。

## 归属规则摘要

请求＝你的一条输入（或 Agent 发来的普通消息）起的轮，连同它引出的续轮：子会话完成通知按 `parentRunId` 归发起轮所在的请求，后台命令通知并入前一个请求。清单是下面几层的并集，按（仓，文件）去重，标来源：

1. 检查点（只含工作目录那个仓，可能含并发线程）；
2. `file_change`（路径向上找 `.git`；被忽略或仓外的单列“交付物”；已删的手建工作树按相对路径对提交文件）；
3. 命令真正做出的提交：提交类命令（commit／merge／cherry-pick／rebase／pull／am／revert）执行区间 ±3 秒内的提交，加括号形式 `[分支 号]` 的输出，范围（`push／pull／merge` 的 `a..b`）；
4. 按子会话链折进来的各层子线程（深度 ≤8，防环）。

候选仓：本请求 `file_change` 的仓、命令里的绝对路径所在的仓、没有路径时用上一条 `cd` 的目录或线程工作目录的仓；没找到再探测全部发现仓，此时必须有路径证据（带目录的提交文件路径出现在命令里，或命令点名了仓名）；第二遍把收到提交的仓当证据仓再扫一遍。被改写的提交按 patch-id、再按唯一标题加文件重合 ≥50% 找主线上的等价提交。`t3 checkpoint` 开头的提交排除。

## 盲区（页面脚注原文）

只改不提交且不是用 Edit／Write 改的嵌套仓文件看不到；命令输出超过 1 MiB 时尾部提交号可能缺；脚本里调用 git 而命令本身不含提交类动词的提交看不到；别的线程恰在某条提交类命令执行期间在同一仓里提交的可能算进来（实测约 5%，集中在总仓）；“现仍未提交”是现在的状态。

## 上游文件改动（相对 `f227e28bb3`，只插入）

共 53 行插入、3 行改行（`git diff --numstat f227e28bb3 HEAD` 里非 `localReview` 的文件）：

| 文件                                                            | 插入             | 挂的是什么                                         |
| --------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                                 | 23               | 导入、两个方法名、两个 RPC 定义、并入 RPC 组       |
| `packages/contracts/src/index.ts`                               | 1                | 导出                                               |
| `apps/server/src/ws.ts`                                         | 4                | 取服务、两个处理器                                 |
| `apps/server/src/server.ts`                                     | 2                | 层组装                                             |
| `apps/server/src/auth/RpcAuthorization.ts`                      | 2                | 方法鉴权（列表读编排数据、单请求读文件系统）       |
| `apps/server/src/observability/RpcInstrumentation.ts`           | 2                | 观测表                                             |
| `apps/server/src/ws.test.ts`、`pluginHost/PluginHostWs.test.ts` | 2＋2             | 测试替身                                           |
| `apps/web/src/routes/_chat.pull-requests.tsx`                   | 7（含 3 行改行） | 搜索参数 `source`、`localThread`，页面换成路由包装 |
| `apps/web/src/components/pullRequest/usePullRequestListView.ts` | 3                | 搜索类型                                           |
| `apps/web/src/components/pullRequest/PullRequestsColumn.tsx`    | 2                | 页头挂来源切换                                     |
| `apps/web/src/components/chat/ThreadDetailsPanel.tsx`           | 4                | 详情卡「本线程的请求」行（跟「Changes」开关）      |

Agent 与移动端：本期不接 MCP 工具、不做移动端界面，`WS_METHODS` 新增两项对移动端无影响。

## 同步上游时

`rpc.ts`、`ws.ts`、`server.ts` 的挂载行冲突按插入点重挂；路由包装 `PullRequestsRoute` 若上游改了 PR 页路由，保持 `source !== "local"` 时回到原 `PullRequestsPage`。
