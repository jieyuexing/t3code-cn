# 插件宿主

t3code-zh 自建的通用插件系统，语义参照 Cordis：插件按清单声明它提供和注入的服务，宿主负责依赖齐了才启动、注册可撤销、提供方下线时依赖方自动停下、回来后自动恢复。同一份服务声明同时生成四种入口：别的插件注入、面板视图调用、Agent 工具、命令面板与服务面板。用户决定与取舍记录在总仓 `host/docs/PRODUCT-DIRECTION.md`「2026-11-10：围绕 T3 Code 做插件机制」，本文只写现行结构和同步时怎么维护。

## 现行形态

- **清单**：插件目录根上的 `plugin.json`，按 Agent Plugins 1.0；T3 专有字段放在 `extensions["com.jieyuexing.t3code"]`，包括 `entry`、`capabilities`、`inject`、`provides`、`views`、`title`。格式以 `packages/contracts/src/pluginHost/manifest.ts` 为准，写法看 `plugin-host-examples/` 下的三个示例。
- **运行**：每个插件跑在一个受监督的子进程里，插件用到才启动。这是受信的本机代码，不是沙箱。子进程入口是 `apps/server/src/pluginHost/childRuntime.ts`。
- **服务**：服务名全局唯一。提供方停用、隔离或重载时，依赖它的插件进入 `waiting`。方法标 `"agent": true` 的进 Agent 工具 `plugin_services`／`plugin_call`；标 `"ui": true` 的进命令面板和服务面板。
- **视图**：整页 HTML，放在沙箱 iframe 里；可从命令面板、右侧面板空状态的「打开视图」列表和标签栏 “+” 菜单打开（后两处在内置项之后一行一个，没有快捷键，宿主关闭或没有视图时不出现，逻辑在 `launcherViews.ts`、`PluginLauncher.tsx`，用路由里的当前线程，草稿线程和拉取请求页没有），经 MessagePort 桥调用插件处理器，或调用插件注入的服务。消息见下文「视图桥」。
- **开关**：设置页「插件」按环境管理，环境级总开关默认关。
- **设置项**：清单 `settings` 声明字段（`text`、`boolean`、`number`，暂无 `select`、`secret`）。设置页插件行声明了设置项就显示「设置」按钮和“N 项设置”，点开在行下方展开表单（`PluginSettingsForm.tsx`），经已有的 `setSetting` 保存：文本、数字回车或离开输入框时保存，开关切换即保存，数字不是有限数字时就地提示、不保存；值不等于默认值时显示“恢复默认（默认值）”，保存成功短暂显示“已保存”，宿主拒绝时错误显示在字段下方、输入保留；没有管理权限时只读；停用、出错或被隔离的插件照样可以改。设置按环境保存，不分项目；写入后插件下一次读取即生效，不用重载。
- **Cordis 写法**：可选的适配包在 `plugin-host-cordis/`，不进 pnpm workspace，自带 npm 锁文件，`cordis` 版本固定在这里，宿主代码不依赖它。

## 视图桥

页面发 `ready` 后收到一个 MessagePort，之后在端口上收发 JSON 字符串。

| 方向        | `_tag`                                               | 说明                                                                           |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| 页面 → 宿主 | `call` `callService` `callHost` `cancel` `pong`      | 带 `id`（`cancel` 指向要取消的 `id`）；单条消息上限 64K 字符，嵌套不超过 32 层 |
| 宿主 → 页面 | `init` `context` `result` `error` `ping` `violation` | `init` 是 `{pluginId, viewId, title, context}`；`context` 是 `{context}`       |

- **`context`**：`{ cwd, focus, theme: { scheme, vars } }`。`cwd` 是当前线程的工作目录（有 worktree 取 worktree，否则取项目根，来自右面板收到的 `files.workspaceRoot`），没有线程时为 `null`。`scheme` 是 `light` 或 `dark`；`vars` 是 T3 页面根元素上各变量的计算值，缺的不发。`init` 带一份，之后 `cwd`、`focus` 或主题变了宿主再发一条 `{_tag:"context", context}`（内容没变不发）。主题靠监听根元素的 `class` 和 `style` 变化发现，主题编辑器的实时改色也会带来更新。宿主不用 `ui/notifications/host-context-changed`，那是页面服务路由给 `html_render` 页用的。
- **`focus`**：`{ path: "<绝对路径>", kind: "folder" | "file" } | null`，是本线程右侧面板里“最近一次激活的文件或目录标签”所指的位置，供版本控制类插件跟着文件面板走。取值在 `apps/web/src/pluginHost/focusSurface.ts` 与 `usePluginFocus.ts`，不动上游文件：
  - 只看 `files`（文件浏览器，指工作区根，`kind` 为 `folder`）和 `file` 标签（聊天附件不算）。`file` 标签的 `relativePath` 可以是目录（面板靠读文件失败才知道），所以 `kind` 由宿主用面板同一个读文件查询判定，`path_not_file` 为 `folder`，其余为 `file`；`relativePath` 是 `.` 时视为工作区根。路径与面板一致，用 `resolvePathLinkTarget(relativePath, cwd)`，所以可以是工作区之外的绝对路径。
  - “最近一次激活”：模块加载时订阅右面板 store，每次状态变化，若当前激活的是上述标签就记下它；激活的是别的标签（含插件自己的标签）时沿用记下的那个；记下的标签被关掉、或页面重载后没有记录时，取仍开着的最后一个上述标签（按标签顺序，近似“最近打开”）；一个都没有则为 `null`。`navigateFolder` 原地换标签时新标签 id 被激活，随之更新。记录在内存里，按线程分开。
  - `kind` 还没读出来时不发猜测：已发过则维持上一个答案，从没发过则视图暂不挂载（`init` 之前等它）。读失败（缺文件、无读权限）按 `file`。
  - 插件视图只在自己的标签可见时挂载，用户到文件标签再回来是新的 `init`；在线收到 `context` 变化的场景主要是被记住的标签在插件可见时被关掉。
- **主题变量**：`--background` `--foreground` `--muted` `--card` `--popover` `--secondary` `--primary` `--accent` `--destructive` `--success` `--warning` `--info` `--code-background`，其中除 `--foreground` 外各项另有 `-foreground`；另有 `--border` `--input` `--ring` `--warning-surface` `--radius` `--font-sans` `--font-mono`。清单在 `apps/web/src/pluginHost/viewContext.ts`。
- **`callHost`**：`{_tag:"callHost", id, method, input}`，宿主回 `result` 或 `error`。每个方法要求清单 `capabilities` 含对应能力（随同意摘要，改了要重新同意）：`t3.openPluginSettings` 要 `"settings"`；`threads.pending`、`threads.lastReply`、`threads.question`、`t3.openThread` 要 `"host.threads-read"`；`threads.snooze` 要 `"host.threads-organize"`（写，单独声明、单独同意）；其余都要 `"host.vcs-read"`。没声明、或 `method` 不在下表，一律回 `error`，`code` 为 `denied`。Git、差异与线程类调用用当前用户自己的连接代为发出，页面碰不到 T3 的 API（视图 CSP 不变）。结果超过 64K 回 `too-large`。

| `method`                  | `input`                                                          | 结果                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vcs.status`              | `{cwd}`                                                          | T3 的 Git 状态，用 `vcs.refreshStatus` 的 `localOnly`：不 fetch、不问托管平台，只重算本地状态                                                                          |
| `review.diffPreview`      | `{cwd, sourceKind: "working-tree"\|"commit", commitSha?, file?}` | `review.getDiffPreview` 的结果；不给 `file` 时只返回改动文件清单（`metadataOnly`），给 `{path, previousPath?}` 返回该文件的补丁                                        |
| `review.diffFileContents` | 同上，`file` 必填                                                | `{oldContents, newContents}`；改动类型和两端版本由宿主先读该文件的补丁得出，重命名要给 `previousPath`                                                                  |
| `t3.openDiff`             | `{kind: "working-tree"\|"commit", sha?, file?}`                  | 在当前线程打开 T3 的差异面板，选中未提交改动或该提交，并定位到 `file`；返回 `null`                                                                                     |
| `t3.openPluginSettings`   | `{}`（必须是对象，里面的字段一概不读）                           | 打开设置页「插件」，滚动到调用方自己的插件行并展开它的设置；目标永远是调用方，不能指定别的插件；返回 `null`                                                            |
| `threads.pending`         | `{}`                                                             | 当前环境里未归档、未 settle、未稍后处理的顶层线程（不含子会话、旁路对话），每条 `{threadId, title, project, status, request, lastTurnCompletedAt, waitingSince}`；见下 |
| `threads.lastReply`       | `{threadId}`                                                     | `{threadId, text, truncated}`：该线程最后一条 assistant 消息；超过 60000 字符（转义后超过 64000 时再短些）保留末尾并标 `truncated`                                     |
| `threads.question`        | `{threadId}`                                                     | `{threadId, question}`：该线程最近一次结构化提问的第一个问题，没有则 `null`                                                                                            |
| `t3.openThread`           | `{threadId}`                                                     | 在当前窗口打开该线程；返回 `null`                                                                                                                                      |
| `threads.snooze`          | `{threadId, until}`                                              | 走 T3 的稍后处理命令与权限，`until` 是带时区的时间，返回 `null`；线程不能稍后处理（有待审批等）时由命令回 `call-failed`                                                |

只读依据：`vcs.refreshStatus` 的 `localOnly` 走 `VcsStatusBroadcaster.refreshStatus` 的本地分支（`VcsStatusBroadcaster.ts:536-545`），只重算本地状态、用缓存的远端部分，不 fetch、不读远端状态；Git 命令带 `GIT_OPTIONAL_LOCKS=0`（`GitVcsDriverCore.ts:983`）。一个例外：远端地址是 T3 认不出的主机时，读本地状态要识别托管平台，会按 `discovery.ts:378-405` 跑各平台 CLI 的认证探测（结果有缓存），T3 自己的界面读状态走的也是这条。差异预览的未跟踪文件用临时索引（复制真索引到临时文件，在副本里 `add --intent-to-add`，`GitVcsDriverCore.ts:3058-3189`），不写仓库。差异类调用的 `cwd` 由服务端 `assertWorkspaceBoundCwd` 限在已登记的工作区内。第一版不开放任何写接口（`git.runStackedAction`、`vcs.pull`、`switchRef` 等）。

`file` 可以是路径字符串，也可以是 `{path, previousPath?}`；重命名的文件要给 `previousPath`。

线程类方法的数据都在网页端取，与侧栏同一份：`threads.pending` 读客户端的 `navigationThreadShellsAtom`（侧栏用的归档、子会话、委派任务和隐藏标签过滤都已在里面），再按 `settledOverride`、`effectiveSnoozed` 过滤——稍后处理中举手的线程照常列出；`status` 用 `resolveSidebarThreadStatus` 再映射成 `input` `approval` `request` `failed`（含额度上限）`done` `waiting` `working`；`request` 只有种类和创建时间。`waitingSince` 取待答请求的创建时间，其次是 `pendingUserInputAt`，再其次是最近一轮完成时间；子会话在父线程上的提问没有自己的时间，按完成时间算。`threads.lastReply` 与 `threads.question` 走已有的 `threadTranscript` HTTP 取整份对话（服务端上限 50 MiB，超过时回 `call-failed`），长线程较重，视图应按需读取、缓存，不要轮询。逻辑在 `apps/web/src/pluginHost/pendingThreads.ts`，上游文件 0 行。

## 自有目录

| 目录                                               | 内容                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/contracts/src/pluginHost/`               | 清单、RPC 载荷与快照 schema                                                           |
| `apps/server/src/pluginHost/`                      | 加载、对账、子进程、服务转发、Agent 工具、视图交付                                    |
| `apps/web/src/pluginHost/`                         | 视图框与桥、命令面板项、右侧面板「打开视图」与 “+” 菜单里的视图入口、服务面板、设置页 |
| `packages/client-runtime/src/state/pluginHost*.ts` | 网页端按环境的快照状态                                                                |
| `plugin-host-examples/`                            | 示例 `echo-clock`、`greeter`、`git-status`                                            |
| `plugin-host-cordis/`                              | 可选的 Cordis 适配包与示例 `example.counter`                                          |

## 上游挂载点

规则：上游文件只做插入，合计不超过 80 行。目前用了 75 行插入、3 行改动，另有预算快照的 1 行数字和生成的路由表。

| 文件                                                           | 插入              | 挂的是什么                                    |
| -------------------------------------------------------------- | ----------------- | --------------------------------------------- |
| `packages/contracts/src/rpc.ts`                                | 3                 | `pluginHost` 的 WS 方法、RPC 定义、RPC 组     |
| `packages/contracts/src/clientRpcPermissions.ts`               | 1                 | 受保护方法登记                                |
| `packages/contracts/src/index.ts`                              | 1                 | 导出 `pluginHost`                             |
| `packages/client-runtime/package.json`                         | 4                 | `pluginHost` 状态的导出                       |
| `packages/client-runtime/src/rpc/client.ts`                    | 1                 | 客户端 RPC 方法                               |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | 1                 | 权限表测试                                    |
| `apps/server/src/ws.ts`                                        | 4                 | RPC 处理器                                    |
| `apps/server/src/ws.test.ts`                                   | 2                 | 测试替身                                      |
| `apps/server/src/server.ts`                                    | 2                 | 运行时层组装                                  |
| `apps/server/src/binMain.ts`                                   | 3                 | 隐藏命令 `__plugin-host`（子进程入口）        |
| `apps/server/src/auth/RpcAuthorization.ts`                     | 3                 | 方法鉴权                                      |
| `apps/server/src/observability/RpcInstrumentation.ts`          | 2                 | 观测表                                        |
| `apps/server/src/mcp/McpHttpServer.ts`                         | 2                 | Agent 工具集                                  |
| `apps/server/src/provider/AgentContextBudget.test.ts`          | 2                 | 预算测试                                      |
| `apps/server/src/provider/agentContextBudget.json`             | 改 1              | 工具描述字节数，按实测写                      |
| `apps/web/src/rightPanelStore.ts`                              | 11（含 2 处改行） | 面板种类 `plugin` 与打开动作                  |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`    | 3                 | 面板内容分支                                  |
| `apps/web/src/components/RightPanelTabs.tsx`                   | 8                 | 标签标题与图标；空状态与 “+” 菜单里的插件视图 |
| `apps/web/src/closedViewStore.ts`                              | 2                 | 关闭后可重开                                  |
| `apps/web/src/reopenClosedView.ts`                             | 3                 | 关闭后可重开                                  |
| `apps/web/src/components/CommandPalette.tsx`                   | 4（含 1 处改行）  | 命令面板「插件」组                            |
| `apps/web/src/components/DiffPanel.tsx`                        | 5（含 2 处改行）  | 差异面板读插件要求定位的文件                  |
| `apps/web/src/appInit.tsx`                                     | 2                 | 启动时订阅快照                                |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`      | 2                 | 设置页导航项                                  |
| `apps/web/src/components/settings/settingsSearch.ts`           | 4                 | 设置搜索                                      |
| `apps/web/src/routes/_chat.settings.plugins.tsx`               | 新文件 5          | 设置页路由                                    |
| `apps/web/src/routeTree.gen.ts`                                | 生成              | 路由表                                        |

## 同步上游时

1. 冲突落在上表的文件里时，先取上游版本，再按上表把插件那几行插回去，不手工合并上游的改动。`rightPanelStore.ts` 最容易冲突。
2. `routeTree.gen.ts` 不要手合，重新生成。
3. `agentContextBudget.json` 先取上游的三个数，再跑 `apps/server` 的 `vp test run src/provider/AgentContextBudget.test.ts`，把 `mcpToolListJsonBytes` 改成实测值（插件工具比上游多约 479 字节）。
4. 合并后用 `rg -l pluginHost apps packages` 对照上表，缺一处就补一处。然后在 `apps/server` 跑 `vp test run src/pluginHost src/ws.test.ts src/auth/RpcAuthorization.test.ts src/mcp`，在 `apps/web` 跑 `vp test run src/pluginHost`。
5. 插入行数要超过 80 行时，先停下来，写明原因再议，不悄悄放宽。

## 未验证

Electron 桌面端、Windows（141）上的子进程通信、官方手机版（看不到插件）、Agent 工具的 evals（没有 API key）、真实界面里的 “Modifies” 标记。
