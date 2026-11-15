# 插件宿主

t3code-cn 自建的通用插件系统，语义参照 Cordis：插件按清单声明它提供和注入的服务，宿主负责依赖齐了才启动、注册可撤销、提供方下线时依赖方自动停下、回来后自动恢复。同一份服务声明同时生成四种入口：别的插件注入、面板视图调用、Agent 工具、命令面板与服务面板。用户决定与取舍记录在总仓 `host/docs/PRODUCT-DIRECTION.md`「2026-11-10：围绕 T3 Code 做插件机制」，本文只写现行结构和同步时怎么维护。

## 现行形态

- **清单**：插件目录根上的 `plugin.json`，按 Agent Plugins 1.0；T3 专有字段放在 `extensions["com.jieyuexing.t3code"]`，包括 `entry`、`capabilities`、`inject`、`provides`、`views`、`title`。视图可带可选 `icon`（lucide 图标名，宿主只认 `apps/web/src/pluginHost/rail/railIcons.ts` 里的精选表，不在表里或缺省时应用栏画无描边首字；同意摘要不含视图，改 `icon` 不触发重新同意）。格式以 `packages/contracts/src/pluginHost/manifest.ts` 为准，写法看 `plugin-host-examples/` 下的三个示例。
- **运行**：每个插件跑在一个受监督的子进程里，插件用到才启动。这是受信的本机代码，不是沙箱。子进程入口是 `apps/server/src/pluginHost/childRuntime.ts`。子进程环境只带 `PATH`、`HOME` 等 10 个键；服务器自己带 `HTTP(S)_PROXY`／`NO_PROXY` 时一并透传并置 `NODE_USE_ENV_PROXY=1`，插件用 `fetch` 抓取即走同一代理，服务器没有代理变量时不新增任何东西。
- **服务**：服务名全局唯一。提供方停用、隔离或重载时，依赖它的插件进入 `waiting`。方法标 `"agent": true` 的进 Agent 工具 `plugin_services`／`plugin_call`；标 `"ui": true` 的进命令面板和服务面板。
- **视图**：整页 HTML，放在沙箱 iframe 里；可从命令面板、右侧面板空状态的「打开视图」列表和标签栏 “+” 菜单打开（后两处在内置项之后一行一个，没有快捷键，宿主关闭或没有视图时不出现，逻辑在 `launcherViews.ts`、`PluginLauncher.tsx`，用路由里的当前线程，草稿线程和拉取请求页没有），经 MessagePort 桥调用插件处理器，或调用插件注入的服务。消息见下文「视图桥」。
- **开关**：设置页「插件」按环境管理，环境级总开关默认关。
- **设置项**：清单 `settings` 声明字段（`text`、`boolean`、`number`，暂无 `select`、`secret`）。设置页插件行声明了设置项就显示「设置」按钮和“N 项设置”，点开在行下方展开表单（`PluginSettingsForm.tsx`），经已有的 `setSetting` 保存：文本、数字回车或离开输入框时保存，开关切换即保存，数字不是有限数字时就地提示、不保存；值不等于默认值时显示“恢复默认（默认值）”，保存成功短暂显示“已保存”，宿主拒绝时错误显示在字段下方、输入保留；没有管理权限时只读；停用、出错或被隔离的插件照样可以改。设置按环境保存，不分项目；写入后插件下一次读取即生效，不用重载。
- **应用栏**：对话视图最右侧约 40px 的窄栏（`apps/web/src/pluginHost/rail/`，`ChatView.tsx` 在右侧面板之后插入一个元素，并在三图标的两处渲染按栏是否可见置空，嵌入的侧聊天窗格不显示）。自上而下：详情开关（与 `threadPanel.toggle` 同一动作，显示开合；详情卡弹出式时这个按钮本身就是弹层的 `PopoverTrigger`，开合交给 Base UI，否则点正在开着的弹层会被外部点击先关、自己的 click 再开）、固定的 T3 自带面板（默认浏览器、终端、Files、差异；可另加 PR、Linked PR、Device、Side chat）和内置的「待你定」格（默认固定在差异之后，见下文「应用栏『待你定』格」）、插件应用（视图的 `icon`，缺省时无描边首字；插件停用时视图不在快照里，画 Puzzle）、网页应用（无描边首字，不取 favicon），类与类之间一条细线，底部依次是「Right panel」「Terminal drawer」两格开关（沿用 `PanelRight`、`PanelBottom` 图标，亮起表示开着，不可用时灰）和「＋」。栏可见（有线程、非嵌入侧聊、设置里栏开着）时标题栏不再画详情、终端抽屉、右侧面板三个图标，≤980px 的 Sheet 面板里自带的那组保留；关栏、嵌入侧聊时恢复原样。顶部让出 `--workspace-topbar-height`，最大化按钮与窗口右上角的标题栏控件落在这段空白上。选中项用 `bg-input/64`（与标题栏 Toggle 同值），悬停用 `bg-accent`。点击：本线程已有该类标签就切过去，没有就新开，点正在显示的那一项收起面板；网页应用与浏览器图标按各自的标签区分（`webAppTabs.ts` 记本次会话打开的标签，重载后按页面地址认）。图标右键：取消固定、编辑与删除（网页应用）；同类内可拖动排序。「＋」弹层勾选要固定的自带面板与插件应用，网页应用（标题、`http(s)` 地址、浏览器配置档）在这里添加、编辑、删除。网页应用经 `browserTab.ts` 的 `openBrowserTab` 打开，与插件视图的 `browser.open` 是同一条路径。
  - **存放**：服务端按环境存 `<stateDir>/plugins/rail.json`（与 `registry.json` 同目录），契约在 `packages/contracts/src/pluginHost/rail.ts`。读走快照的 `rail` 字段（可缺省，旧服务端回落默认），写走 `pluginHost.call` 的 `setRail`（整份替换）；没有新增 RPC 方法。总开关关着也能读写：`setRail` 不受 `host-disabled` 限制，启动时读完 `rail.json` 一定发一帧。文件不存在用默认（应用栏开，固定浏览器、终端、Files、差异、待你定）；已有的 `rail.json` 不会自动补上待你定，要在「＋」弹层里勾选，或在 `items` 里加 `{"_tag":"builtin","id":"needsYou"}`；读不出或不合模式时显示默认并拒绝覆盖，与 `registry.json` 一样。条数、重复、`http(s)` 由契约校验，服务端同样受约束。
  - **开关**：设置页「插件」顶上的「Right app rail」，默认开，关掉整条栏消失、固定项保留。总开关关闭时不列插件应用，栏本身照常；没有 `pluginHost.call` 权限时栏只读。
  - **插件应用的灰态**：固定项自带标题，所以插件被撤下视图时仍显示；插件未启用、待同意、等待依赖、退避、隔离、或不再提供该视图时变灰且点不动，只有 `standby`（用到才启动）和运行中算可用；等待依赖、待同意的右上角带 6px 警告点，隔离带错误点，关闭、未安装不带点。
  - **只有 `preview.toggle`、`diff.toggle`、`threadPanel.toggle` 在提示里带快捷键**；终端的 `terminal.toggle` 开关的是底部抽屉，不是右侧面板的终端标签，所以不带。
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
- **`callHost`**：`{_tag:"callHost", id, method, input}`，宿主回 `result` 或 `error`。每个方法要求清单 `capabilities` 含对应能力（随同意摘要，改了要重新同意）：`t3.openPluginSettings` 要 `"settings"`；`threads.pending`、`threads.lastReply`、`threads.question`、`t3.openThread` 要 `"host.threads-read"`；`threads.snooze` 要 `"host.threads-organize"`（写，单独声明、单独同意）；`t3.openUrl` 要 `"host.open-url"`（只放行 `http:`／`https:`，走系统浏览器）；`browser.open`、`browser.profiles` 要 `"host.browser"`（把页面开成当前线程 T3 浏览器的一个标签，带登录态的配置档由 T3 浏览器管，见下表）；`t3.openFile` 要 `"host.open-file"`（在当前线程右侧文件面板开一个工作区内的文件）；其余都要 `"host.vcs-read"`。没声明、或 `method` 不在下表，一律回 `error`，`code` 为 `denied`。Git、差异与线程类调用用当前用户自己的连接代为发出，页面碰不到 T3 的 API（视图 CSP 不变）。结果超过 64K 回 `too-large`。

| `method`                  | `input`                                                          | 结果                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vcs.status`              | `{cwd}`                                                          | T3 的 Git 状态，用 `vcs.refreshStatus` 的 `localOnly`：不 fetch、不问托管平台，只重算本地状态                                                                                                                                                                                                                       |
| `review.diffPreview`      | `{cwd, sourceKind: "working-tree"\|"commit", commitSha?, file?}` | `review.getDiffPreview` 的结果；不给 `file` 时只返回改动文件清单（`metadataOnly`），给 `{path, previousPath?}` 返回该文件的补丁                                                                                                                                                                                     |
| `review.diffFileContents` | 同上，`file` 必填                                                | `{oldContents, newContents}`；改动类型和两端版本由宿主先读该文件的补丁得出，重命名要给 `previousPath`                                                                                                                                                                                                               |
| `t3.openDiff`             | `{kind: "working-tree"\|"commit", sha?, file?}`                  | 在当前线程打开 T3 的差异面板，选中未提交改动或该提交，并定位到 `file`；返回 `null`                                                                                                                                                                                                                                  |
| `t3.openPluginSettings`   | `{}`（必须是对象，里面的字段一概不读）                           | 打开设置页「插件」，滚动到调用方自己的插件行并展开它的设置；目标永远是调用方，不能指定别的插件；返回 `null`                                                                                                                                                                                                         |
| `threads.pending`         | `{}`                                                             | 当前环境里未归档、未 settle、未稍后处理的顶层线程（不含子会话、旁路对话），每条 `{threadId, title, project, status, request, lastTurnCompletedAt, waitingSince}`；见下                                                                                                                                              |
| `threads.lastReply`       | `{threadId}`                                                     | `{threadId, text, truncated}`：该线程最后一条 assistant 消息；超过 60000 字符（转义后超过 64000 时再短些）保留末尾并标 `truncated`                                                                                                                                                                                  |
| `threads.question`        | `{threadId}`                                                     | `{threadId, question}`：该线程最近一次结构化提问的第一个问题，没有则 `null`                                                                                                                                                                                                                                         |
| `t3.openThread`           | `{threadId}`                                                     | 在当前窗口打开该线程；返回 `null`                                                                                                                                                                                                                                                                                   |
| `threads.snooze`          | `{threadId, until}`                                              | 走 T3 的稍后处理命令与权限，`until` 是带时区的时间，返回 `null`；线程不能稍后处理（有待审批等）时由命令回 `call-failed`                                                                                                                                                                                             |
| `t3.openUrl`              | `{url}`                                                          | 在系统浏览器打开一个绝对 `http:`／`https:` 地址，返回 `null`；其他协议、相对路径或解析失败回 `invalid`                                                                                                                                                                                                              |
| `browser.open`            | `{url, profileId?, background?}`                                 | 在当前线程右侧面板的 T3 浏览器里开一个标签（与点聊天里的链接同一条路径 `openUrlInPreview`），返回 `null`；`url` 只放行 `http:`／`https:`，`profileId` 须在 `browser.profiles` 里，`background: true` 不切走当前标签；没有线程、没有预览权限或预览不可用回 `call-failed`                                             |
| `browser.profiles`        | `{}`                                                             | `[{id, name, kind: "persistent"\|"incognito"}]`：T3 设置「浏览器」里的配置档，内置 `default`（持久）与 `incognito`                                                                                                                                                                                                  |
| `t3.openFile`             | `{path, line?}`                                                  | 在当前线程右侧文件面板开一个文件标签（`useRightPanelStore.openFile`，与文件树点开同一条路径），返回 `null`；`path` 是绝对路径或相对工作区根的路径，规整（`.`、`..`）后必须在线程工作区之内，否则回 `invalid`（含工作区根本身与同前缀的兄弟目录）；`line` 是正整数，定位到该行；没有线程或没有工作区回 `call-failed` |

只读依据：`vcs.refreshStatus` 的 `localOnly` 走 `VcsStatusBroadcaster.refreshStatus` 的本地分支（`VcsStatusBroadcaster.ts:536-545`），只重算本地状态、用缓存的远端部分，不 fetch、不读远端状态；Git 命令带 `GIT_OPTIONAL_LOCKS=0`（`GitVcsDriverCore.ts:983`）。一个例外：远端地址是 T3 认不出的主机时，读本地状态要识别托管平台，会按 `discovery.ts:378-405` 跑各平台 CLI 的认证探测（结果有缓存），T3 自己的界面读状态走的也是这条。差异预览的未跟踪文件用临时索引（复制真索引到临时文件，在副本里 `add --intent-to-add`，`GitVcsDriverCore.ts:3058-3189`），不写仓库。差异类调用的 `cwd` 由服务端 `assertWorkspaceBoundCwd` 限在已登记的工作区内。第一版不开放任何写接口（`git.runStackedAction`、`vcs.pull`、`switchRef` 等）。

`file` 可以是路径字符串，也可以是 `{path, previousPath?}`；重命名的文件要给 `previousPath`。

线程类方法的数据都在网页端取，与侧栏同一份：`threads.pending` 读客户端的 `navigationThreadShellsAtom`（侧栏用的归档、子会话、委派任务和隐藏标签过滤都已在里面），再按 `settledOverride`、`effectiveSnoozed` 过滤——稍后处理中举手的线程照常列出；`status` 用 `resolveSidebarThreadStatus` 再映射成 `input` `approval` `request` `failed`（含额度上限）`done` `waiting` `working`；`request` 只有种类和创建时间。`waitingSince` 取待答请求的创建时间，其次是 `pendingUserInputAt`，再其次是最近一轮完成时间；子会话在父线程上的提问没有自己的时间，按完成时间算。`threads.lastReply` 与 `threads.question` 走已有的 `threadTranscript` HTTP 取整份对话（服务端上限 50 MiB，超过时回 `call-failed`），长线程较重，视图应按需读取、缓存，不要轮询。逻辑在 `apps/web/src/pluginHost/pendingThreads.ts`，上游文件 0 行。

**剪贴板（`host.clipboard-write`）**：视图 iframe 保持 `sandbox="allow-scripts allow-forms"`（不加 `allow-same-origin`），清单声明 `host.clipboard-write` 的插件才在 iframe 上多一个 `allow="clipboard-write"`，让页面里的 `navigator.clipboard.writeText` 能写系统剪贴板；没声明的视图没有这个委派（权限策略拒绝，与之前相同），读剪贴板（`clipboard-read`）永远不委派。安全面：页面无同源身份，只能在用户手势下写文本，不能读，最坏是把一段文本放进剪贴板，所以按能力放行、进同意摘要，而不是对所有视图开放。浏览器自己的剪贴板权限仍然有效：Electron 桌面端与网页端对它的处理由各自的会话决定，没有在桌面端验证（见「未验证」）。逻辑在 `PluginViewFrame.tsx` 一处表达式，上游 0 行。

`browser.open` 不改变 T3 的链接打开偏好：插件明确要求开在 T3 浏览器，所以不看 `browserLinkTarget` 设置；也不回退系统浏览器，插件要回退自己再调 `t3.openUrl`。逻辑在 `apps/web/src/pluginHost/hostApi.ts` 与 `useHostApi.ts`（复用 `~/browser/openFileInPreview.ts` 的 `openUrlInPreview` 与 `browserHistoryStore`），上游文件 0 行；没有新增 RPC，所以不涉及客户端权限表。

## 自有目录

| 目录                                               | 内容                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/pluginHost/`               | 清单、RPC 载荷与快照 schema、应用栏配置（`rail.ts`）、视图声明的 `icon`                                   |
| `apps/server/src/pluginHost/`                      | 加载、对账、子进程、服务转发、Agent 工具、视图交付                                                        |
| `apps/web/src/pluginHost/`                         | 视图框与桥、命令面板项、右侧面板「打开视图」与 “+” 菜单里的视图入口、服务面板、设置页                     |
| `apps/web/src/pluginHost/rail/`                    | 应用栏：组件、固定与点击的纯逻辑、图标表、「＋」弹层、网页应用表单与标签记录、配置读写、栏是否可见的 hook |
| `packages/client-runtime/src/state/pluginHost*.ts` | 网页端按环境的快照状态                                                                                    |
| `plugin-host-examples/`                            | 示例 `echo-clock`（带 `icon`）、`greeter`、`git-status`                                                   |
| `plugin-host-cordis/`                              | 可选的 Cordis 适配包与示例 `example.counter`                                                              |

## 上游挂载点

规则：上游文件只做插入、逻辑放 fork 自有目录；行数不设硬上限，只作冲突面参考（用户 11-15：“可以很大程度的放宽改上游文件的上限 我并没有严格要求过”）。

基线是最近一次同步的上游 nightly `v0.1.10-nightly.20261114.4709`（`dfd2187ccb`）。下表只计插件宿主与应用栏的行，同一文件里的其他 fork 定制另列在表后。重算方法：

```sh
git diff --numstat v0.1.10-nightly.20261114.4709 HEAD -- <表内文件>   # 整个文件的增删
git diff -U0 v0.1.10-nightly.20261114.4709 HEAD -- <文件>            # 逐行挑出插件宿主的部分
```

待你定格没有新增上游文件行。插入行数里含改行（一行删一行加）的，在“挂的是什么”里写明。合计 **121 行插入（其中 9 行是改行）**：插件宿主 77 行、应用栏 38 行（含 2 行改行）、详情卡计划区 6 行（其中 1 行改行）；另有预算快照的 1 行数字、设置页路由新文件 5 行和生成的路由表 21 行。此前写的“75＋3”对不上，是漏计了 `McpHttpServer.ts` 把工具集 `export` 出来的改行、`DiffPanel.tsx` 少算 1 行。

| 文件                                                           | 插入              | 挂的是什么                                                                                           |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                                | 3                 | `pluginHost` 的 WS 方法、RPC 定义、RPC 组                                                            |
| `packages/contracts/src/clientRpcPermissions.ts`               | 1                 | 受保护方法登记                                                                                       |
| `packages/contracts/src/index.ts`                              | 1                 | 导出 `pluginHost`                                                                                    |
| `packages/client-runtime/package.json`                         | 4                 | `pluginHost` 状态的导出                                                                              |
| `packages/client-runtime/src/rpc/client.ts`                    | 1                 | 客户端 RPC 方法                                                                                      |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | 1                 | 权限表测试                                                                                           |
| `apps/server/src/ws.ts`                                        | 4                 | RPC 处理器                                                                                           |
| `apps/server/src/ws.test.ts`                                   | 2                 | 测试替身                                                                                             |
| `apps/server/src/server.ts`                                    | 2                 | 运行时层组装                                                                                         |
| `apps/server/src/binMain.ts`                                   | 3                 | 隐藏命令 `__plugin-host`（子进程入口）                                                               |
| `apps/server/src/auth/RpcAuthorization.ts`                     | 3                 | 方法鉴权                                                                                             |
| `apps/server/src/observability/RpcInstrumentation.ts`          | 2                 | 观测表                                                                                               |
| `apps/server/src/mcp/McpHttpServer.ts`                         | 3（含 1 处改行）  | Agent 工具集（改行是把工具集 `export` 出来）                                                         |
| `apps/server/src/provider/AgentContextBudget.test.ts`          | 2                 | 预算测试                                                                                             |
| `apps/server/src/provider/agentContextBudget.json`             | 改 1              | 工具描述字节数，按实测写                                                                             |
| `apps/web/src/rightPanelStore.ts`                              | 11（含 2 处改行） | 面板种类 `plugin` 与打开动作                                                                         |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`    | 3                 | 面板内容分支                                                                                         |
| `apps/web/src/components/RightPanelTabs.tsx`                   | 8                 | 标签标题与图标；空状态与 “+” 菜单里的插件视图                                                        |
| `apps/web/src/closedViewStore.ts`                              | 2                 | 关闭后可重开                                                                                         |
| `apps/web/src/reopenClosedView.ts`                             | 3                 | 关闭后可重开                                                                                         |
| `apps/web/src/components/CommandPalette.tsx`                   | 4（含 1 处改行）  | 命令面板「插件」组                                                                                   |
| `apps/web/src/components/DiffPanel.tsx`                        | 6（含 2 处改行）  | 差异面板读插件要求定位的文件                                                                         |
| `apps/web/src/components/ChatView.tsx`                         | 38（含 2 处改行） | 应用栏：2 行导入、1 行 hook、33 行元素与各自带面板的打开方式、可用条件，2 处改行是栏可见时置空三图标 |
| `apps/web/src/components/chat/threadDetailsItems.ts`           | 1                 | 详情卡条目 `plan`                                                                                    |
| `apps/web/src/components/chat/ThreadDetailsPanel.tsx`          | 4                 | 详情卡顶部挂载 `ThreadPlanSection`                                                                   |
| `apps/web/src/components/chat/ThreadDetailsCard.tsx`           | 改 1              | 计划步骤列表不计入档位高度                                                                           |
| `apps/web/src/appInit.tsx`                                     | 2                 | 启动时订阅快照                                                                                       |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`      | 2                 | 设置页导航项                                                                                         |
| `apps/web/src/components/settings/settingsSearch.ts`           | 4                 | 设置搜索                                                                                             |
| `apps/web/src/routes/_chat.settings.plugins.tsx`               | 新文件 5          | 设置页路由                                                                                           |
| `apps/web/src/routeTree.gen.ts`                                | 生成 21           | 路由表                                                                                               |

整个文件的增删比上表大的几处，多出来的不是插件宿主：`packages/client-runtime/package.json`（+4 `composer-thread-query-cn` 导出，另有删除 4 行 `load-balancing`）、`apps/server/src/server.ts`（+10 −1，`ProjectCheckout`）、`apps/server/src/provider/AgentContextBudget.test.ts`（+4，`HostResources`、`ProjectCheckout` 的测试替身）。

`ChatView.tsx` 这 38 行里 33 行是把 8 个自带面板的“可用吗、怎么打开”从 `useRightPanelActions` 的返回值接到应用栏上，因为这些条件（终端能不能开、PR 页有没有目标、旁路对话是否提供）只在 `ChatView` 里能算。这是目前最大的单文件冲突面；同步时它冲突了，取上游版本再按此表插回，不要手合。要压到几行，办法是让 `useRightPanelActions` 返回一份现成的 `railBuiltins`，那是改上游 hook，不在这一步做。

## 应用栏「待你定」格

内置在 fork 自有目录 `apps/web/src/pluginHost/needsYou/`，取代 `t3-pending` 插件（插件退役由总仓做，本仓不依赖它）。栏上的一格（内置项 id `needsYou`，lucide `message-circle-question-mark`，提示文字 “Needs you”），右上角徽标是等你的线程数，0 时不显示；这格本身是弹出层的 `PopoverTrigger`，点一次开、再点一次关。点开是弹出列表，标题带条数，没有待决时显示“没有等你定的事”。弹出层内的 `pointerdown` 不向上冒泡，否则会触发栏上这一项的拖动排序。

- **清单**：当前环境未归档、未 settle、未稍后处理的顶层线程，状态按 `pendingThreads.ts`（与侧栏同一份分类）。原生需要你的（待审批、待答提问、访客请求、失败含额度上限）直接列；状态是完成或等待的，读最后一条回复里的「待你定」段，有才列，只列第一条，写法与旧插件一致（`replyPending.ts`，测试一并搬来）。按等待起点从早到晚排，不知道起点的最后。
- **取数与成本**：清单读客户端的 `navigationThreadShellsAtom`，经一个去重的派生 atom（`useNeedsYou.ts`）只在相关线程变化时才重算，**不轮询**。回复正文只有对话记录里有（线程摘要的 `latestVisibleMessage` 服务端始终填 `null`），但**不读整份对话**（真实库里单条线程可达 9–31 MB）：`threadTail.ts` 经 `ThreadSnapshotLoader`（`@t3tools/client-runtime/state/threads` 导出、网页运行时已提供的那个）取线程视图打开时用的有界快照，窗口上限约 1 MiB，在本地可见的行里找最后一条 `assistant_message`／`user_input_request`。每条线程只在它又完成一轮、或换了一张提问卡时读一次，一次 4 个并发，结果缩成一行文字存在本次会话内。实测一条 30 轮、1891 项的线程：整份 `transcript` 17,264,523 字节，有界快照 106,785 字节（75 行），约 1/160。读失败的下次线程清单变化时再试。服务端不动。
- **没有往前翻页**：窗口里没有助手消息就当没有待决。分页读取封装 `fetchEnvironmentThreadHistoryPage`（`threadHistoryHttp.ts`）client-runtime 没有导出，要用得在上游 `threads.ts` 加一行 `export * as ThreadHistoryHttp from "./threadHistoryHttp.ts"`（外加自己拼签名和授权），这是上游改动，没有做。窗口至多 75 行或 10 个用户轮，窗口内没有助手消息只会出现在最新一轮全是工具调用而尚未回复时，此时线程本来也没有待决。
- **行内动作**：打开线程；稍后处理（到本地次日 09:00，`threadEnvironment.snooze`）；审批「允许一次」「拒绝」（`respondToApproval`，`accept`／`decline`，请求 id 取自线程摘要的 `pendingRuntimeRequest`）；回复待决一个「按推荐」按钮和一行输入框，都是向该线程发一条新消息（`startTurn`，沿用线程自己的 `runtimeMode`，`dispatchMode` 缺省）并起新一轮。结构化提问只给「打开线程」：答案按题、选项、多选与附件逐项作答，选项只在对话记录里、不在线程摘要里，就地作答等于重做一遍问答卡。发送或回答成功后该行显示结果，线程进入处理中就从清单消失。命令失败时错误显示在行内。
- **上游改动**：0 行。只动 fork 自有的 `pluginHost/rail/`、`pluginHost/needsYou/` 与契约 `pluginHost/rail.ts`（内置项 id 与默认固定）。
- **没有覆盖**：Electron 桌面端与 141 Windows 上没有走查；远端环境只用当前线程所在环境的清单，不跨环境汇总；线程在稍后处理中又被举手时清单照常列出，与侧栏一致。

## 详情卡「Plan」

详情卡最上方的「Plan」项（条目 id `plan`，默认显示，设置与卡片右键可关）读本线程最新一份 `todo_list` 计划，逻辑与组件在 `apps/web/src/pluginHost/threadPlan/`，不新增订阅，跟着聊天页已有的线程结构走。

- **取哪份**：非 `superseded` 的 `todo_list` 中，先比 run 先后，再比计划的 `todo_list` 条目先后（计划 id 是随机数，数组顺序不可信；条目不在已加载窗口时退回数组顺序）。步骤全部完成或计划状态为 `completed` 时显示 “Plan complete N/N” 一行，直到出现下一份计划；没有计划整项不渲染。计划所属 run 已不在进行（`queued`、`preparing`、`starting`、`running`、`waiting` 以外）而计划未完成时显示 “Plan N/M · stopped”：标题 muted，原 running 的步骤用 muted 暂停图标、不高亮、不显示已用时长。判断条件与已用时长是同一个 `live`。
- **三档**：full 为标题、细进度条、折叠的 “N done”、进行中步骤（run 仍在进行时显示分钟粒度的已用时长，来自 `durationAnchorAt`）、逐条待办（超过 5 条 “+N more”）；compact 只留标题行和当前步骤；essential 只留 “Plan 3/7”。进度条以下的整块（“N done”、进行中步骤、待办、“+N more”）包在 `data-thread-plan-list` 里，与服务器、PR 列表一样不计入档位高度，所以计划推进、展开收起都不会让卡片在 full 与 compact 之间来回跳（实测计入高度在 0/3 与 1/3 时都是 288px，修前是 316 与 348）。展开状态按线程重置。
- **对外接口**：`useThreadPlanProgress(threadRef)`（`threadPlan/useThreadPlan.ts`）返回 `{ done, total, complete, stopped, currentStep } | null`，供应用栏「详情」格的进度徽标使用。

## 同步上游时

1. 冲突落在上表的文件里时，先取上游版本，再按上表把插件那几行插回去，不手工合并上游的改动。`rightPanelStore.ts` 与 `ChatView.tsx` 最容易冲突。
2. `routeTree.gen.ts` 不要手合，重新生成。
3. `agentContextBudget.json` 先取上游的三个数，再跑 `apps/server` 的 `vp test run src/provider/AgentContextBudget.test.ts`，把 `mcpToolListJsonBytes` 改成实测值（插件工具比上游多约 479 字节）。
4. 合并后用 `rg -l pluginHost apps packages` 对照上表，缺一处就补一处。然后在 `apps/server` 跑 `vp test run src/pluginHost src/ws.test.ts src/auth/RpcAuthorization.test.ts src/mcp`，在 `apps/web` 跑 `vp test run src/pluginHost`。
5. 合并后用上面“重算方法”的两条命令重算上表，把基线换成新同步的上游 nightly，行数变了就改表。

## 未验证

应用栏只在网页端（Chrome＋开发服务器）走查过：宽窗口（详情卡内嵌）、窄窗口（详情卡弹出，点两次能开关，Esc、点外部能关）、右侧面板与底部终端抽屉两格、面板最大化、切换线程、「＋」添加网页应用并点开、插件应用的固定、图标、未知图标退回字标、待同意变灰带警告点、计划进度徽标、拖动排序、右键菜单。没有验证的有：Electron 桌面端（标题栏控件与原生右键菜单）、141 Windows 的标题栏、远端客户端、触屏。窗口 ≤980px 时右侧面板是模态 Sheet，覆盖在应用栏上，应用栏在 Sheet 打开期间点不到，收起靠 Sheet 自己的关闭；这是 T3 原有的 Sheet 行为，没有为此改上游的 `RightPanelSheet`。应用栏的图标没有键盘重排（只有拖动），键盘用户可以用右键菜单之外的「＋」弹层增删，但不能调顺序。

`host.clipboard-write` 与 `t3.openFile` 只在网页端（headless Chrome＋服务端）走查过，Electron 桌面端的剪贴板权限与文件面板行为没跑；`browser.open` 只在网页端加服务端浏览器（headless Chromium）下走查过，Electron 桌面端自带 webview 的路径没跑；Electron 桌面端、Windows（141）上的子进程通信、官方手机版（看不到插件）、Agent 工具的 evals（没有 API key）、真实界面里的 “Modifies” 标记。
