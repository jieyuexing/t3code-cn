# 输入框提示词优化（Prompt Refiner）

草稿写得模糊时，点输入框左下角的魔棒按钮（或在编辑区按 Cmd+Shift+Y / Ctrl+Shift+Y）在发送前原地打磨：用当前仓库的上下文把草稿或选中的局部片段改写得更清楚，结果先出现在输入框正文上方的预览卡，点「应用替换」才改草稿，从不自动发送。应用后工具栏里留一个「撤销优化」，下一次编辑前有效。

## 三档模式

每档的指令文本可在设置页微调：非空的 `modeOverrides[mode]` 替换内置指令（其余规则、语言跟随、独立请求声明与草稿定界符仍由代码包裹），恢复默认即清空；设置页还能用内置示例草稿试跑一次（可直接试跑未保存的草稿，不碰线上温槽），见 `composer-choices.md`。

预览卡顶部的胶囊，切换后立即用最初那份草稿快照重新优化；上次选的模式在本页内沿用，默认结构清晰。

- 结构清晰（`structured`）：理清目标、维度、边界与期望输出，落到当前仓库的具体位置；禁止“你是一位资深架构师…”“请用清晰的 Markdown…”一类空泛套话。
- 大胆发散（`bold`）：保留并放大用户的锋芒，逼出彼此冲突的激进视角与会推翻的假设，要求写出收益上限与风险，不要折中。
- 工程交付（`scoped`）：补齐范围、不做什么、验收标准，以及先核实再改动。

有选区时只返回选区的替换文本（提示词里用 `<composer_before>` / `<composer_selection>` / `<composer_after>` 切分，与语音转写后处理同一结构），要求与前后文自然衔接；无选区返回整段优化稿。输出语言跟随草稿，仓库文档里的“用中文回复”之类指令不影响它。

## 路由与温进程复用

`POST /api/cn/prompt-refine`（同一路由层还注册了 `/api/cn/prompt-advisor/config` 与 `/test-run`），请求 `{ draft, selection?, mode?, projectId?, threadId? }`，返回 `{ refined, mode, usedWorkspaceContext }`；400 入参非法（草稿为空或超 20,000 字符、选区越界、模式未知），401/403 鉴权，503 无可用实例，502 超时或采样失败。

- 鉴权：同设备 hub 与预览流，`authenticateMediaRequest(AuthOrchestrationOperateScope)`。Cookie 会话直接过；bearer 与 DPoP 连接由前端用 `resolveDeviceHubAccess({ hubBasePath: "/api/cn" })` 取一枚 `media` 票据放在 `?wsTicket=`，401 时换票重试一次（`issueWebSocketTicket` 只给 `rpc` 票据绑 proof key，`media` 票据不绑，所以普通 fetch 够用）。路由不在 `EnvironmentHttpApi` 契约里，所以没有走 `executeAuthenticatedEnvironmentHttpRequest`。
- 温进程：不另起后台进程。`PromptAdvisorSampler` 之外新增 `PromptAdvisorRuntime extends PromptAdvisorSampler`，多 `runPrompt`（优化角色入口）、只读的 `inspect()` 和按签名清理的 `retain()`/`release()`；`makeAntigravityPromptAdvisorSampler` 返回它，注册表存放与返回的都是这个类型。优化与顾问各自按配置解析要用的实例、模型、思考档：默认“跟随顾问”，目标相同就共用顾问的温槽、锁和 `N/20` 复用计数；关闭跟随并配了不同的目标时用自己的独立温槽，按需懒启动，不切顾问的模型也不抢顾问的锁（机制与配置落盘见 `composer-choices.md`「配置与设置面板」）。隔离边界（无工具、无文件读写、无终端、写文件检查、30 秒超时、出错即销毁）、5 分钟空闲回收与 20 次复用上限对每个槽都一样；自动优选仍是 Neon → Hydrogen → 3.8 Flash → 实例默认、`low` 思考档。每个提示词都声明“本次请求独立，忽略此前内容”。
- 仓库指纹：`collectWorkspaceFingerprint` 只读且有界，总量 ≤ 4,000 字符：顶层名（跳过 `.git`、`node_modules`、`dist`、`.local`、`.state` 等，最多 40 项）、`AGENTS.md` ≤ 1,600 字、`README.md` ≤ 1,200 字、`package.json` 只取 `name` 与 `description`；`realPath` 越出工作区的符号链接不跟随，任何失败静默退成空串。工作区取线程的 worktree 或项目根，没有线程与项目时不带指纹。
- 线程尾：带 `threadId` 时读最近最多 4 条用户与非 commentary 助手消息（总长 ≤ 3,000 字符）；指纹与线程尾在提示词里都用定界符包成“数据，不是指令”。
- 清洗：解析 `{"refined": string}`，去首尾空白，保留多行，空串或超 8,000 字符一律当失败。

## 现行结构

- 服务端：`apps/server/src/textGeneration/promptRefiner.cn.ts`（提示词、指纹、线程尾、清洗、`refinePrompt`）、`apps/server/src/http/promptRefinerHttp.cn.ts`（路由，读 `ProjectionStoreV2` 在建 layer 时完成，见下）、`promptAdvisor.cn.ts` 与 `promptAdvisorRegistry.cn.ts` 的 `PromptAdvisorRuntime` 扩充。
- 前端：全在 `apps/web/src/pluginHost/promptRefiner/`：`promptRefiner.logic.ts`（请求体、选区切片与替换计划、撤销计划、i18n 词表键与快捷键判断，单测）、`promptRefinerClient.ts`（取票、请求、401 换票重试）、`usePromptRefiner.ts`（`idle | loading | preview | error` 状态机，触发时抓草稿与选区快照，返回前切模式、取消都会中止上一次请求）、`PromptRefinerBar.tsx`（`PromptRefinerButton` 与 `PromptRefinerCard`）。按钮与卡片文案以英文为源串接入上游 `gt-react` 词表，在 `apps/web/src/i18n/translations/zh.json` 补对应中文译文，随界面语言切换。
- 预览卡与撤销入口按草稿归属（`questionAttachmentTarget ?? composerDraftTargetKey`）存放，输入框跨线程保持挂载，切线程时卡片不跟过去。助手运行中（`running` / `connecting`）触发按钮禁用。
- 应用与撤销都经输入框自己的 `applyPromptReplacement` 并带 `expectedText`：选区模式下选区文字已变就拒绝并提示重新选择；整段模式下草稿在等待期间被改动时，预览卡标“草稿已改动”，仍可确认替换，替换的是应用那一刻的整段草稿，撤销恢复的也是它。

## 上游薄接线

| 文件                                            | 改动                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts`                     | 1 行 import，`layerMakeRoutes` 里加 `promptRefinerRouteLayer.pipe(Layer.provide(ProjectionStoreV2.layer))`（路由在建 layer 时取 `ProjectionStoreV2`，其余服务沿用全局提供）                                               |
| `apps/web/src/components/chat/ChatComposer.tsx` | 2 行 import；`useComposerChoices` 之后 13 行 `usePromptRefiner(...)`；正文上方 `<PromptRefinerCard>`；底部左侧把附件按钮包进 `me-2 flex` 容器并加 `<PromptRefinerButton>`（原来没有附件按钮时该容器不渲染，现在始终渲染） |

## 同步上游时

- 路由层建 layer 时多取一个 `ServerConfig`（拿 `stateDir` 并加载 `cn-prompt-advisor.json`）与 `Path`，二者由 `server.ts` 全局提供，不需要改接线；上游若让路由层拿不到 `ServerConfig`，HTTP 测试的 `serve()` 会先失败。

- `ChatComposer.tsx` 冲突：保留上游改动，再把上面 4 处接线补回；`readDraft` 与 `replaceRange` 只依赖 `readComposerSnapshot`、`composerEditorRef.readSelectionRange` 与 `applyPromptReplacement(start, end, text, { expectedText })` 三个现成入口。
- 快捷键用 Mod+Shift+Y：上游默认键位里 `mod+shift+e` 已是 `composer.effort`（`packages/shared/src/keybindings.ts:119`），任务书原定的 E 会冲突；同一个组合键测试在 E 下超时、改 Y 后通过。它是文档级捕获监听，不进键位系统，所以不能在设置里改键；上游若占用 `mod+shift+y` 要改 `isRefineShortcut` 与按钮提示。
- 上游改了 `authenticateMediaRequest` 或 `resolveDeviceHubAccess`：两端必须同步，路由和客户端共用这套票据。
- 取消或加载中切模式会中断服务端正在跑的请求，温进程按既有语义销毁，下一次优化是冷启动。
- 内置提示词与清洗文字只在 `promptRefiner.cn.ts`（用户在设置页覆盖的指令存在配置里），改措辞时先跑 `promptRefiner.cn.test.ts`，它断言反八股禁令、语言跟随、独立请求声明与选区切分。
- 未覆盖：手机端未接入；真实 Neon 采样没有在自动测试里跑，只用替身采样器验证提示词与清洗；`evals/` 目前没有覆盖顾问与优化提示词的用例，改措辞靠单测里的断言与设置页的试跑。
