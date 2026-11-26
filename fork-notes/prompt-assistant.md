# 输入框提示词助手（快捷条、上下文顾问、提示词优化与统一设置）

## 总览

输入框周围有两件互补的事，共用服务端配置、温槽和一块设置面板：

- **输入框快捷条与上下文顾问**：回复里有带标号的选项时，输入框上方给每个选项一个按钮；每轮结束后，本机 Antigravity 再以“批判性顾问”口吻给 0–1 到 3 条建议。每轮自动，偏快省额度。
- **提示词优化（Prompt Refiner）**：草稿写得模糊时，发送前原地打磨，结果先进预览卡，点「应用替换」才改草稿，从不自动发送。按需触发，偏强表达。
- **统一配置、温槽与设置面板**：两个角色各有自己的实例、模型、思考档，存同一份服务端配置，共用或隔离同一个 Antigravity 运行时里的温槽，在同一块设置页里调。

前端全部收在 `apps/web/src/pluginHost/promptAssistant/` 下三个子目录；「待你定」弹层仍留在 `needsYou/`，两者只共用 `needsYou/replyPending.ts` 的 Markdown 清理（`stripMarkdown`、`pendingItems`）与 `needsYou.logic.ts` 的 `FOLLOW_RECOMMENDATION`。

| 子目录                      | 内容                            |
| --------------------------- | ------------------------------- |
| `promptAssistant/choices/`  | 快捷条与上下文顾问（10 个文件） |
| `promptAssistant/refiner/`  | 提示词优化（6 个文件）          |
| `promptAssistant/settings/` | 统一设置面板（10 个文件）       |

## 输入框快捷条与上下文顾问

回复里列了带标号的选项（甲乙丙丁、A–D）时，输入框编辑区上方给每个选项一个按钮，外加「按推荐」。点选项按钮只把标号填进输入框、不发送，光标在末尾（用户常接着补一句）；点「按推荐」直接把这三个字作为一条消息发出，走输入框自己的发送路径（`submitComposer`），与空输入框里打“按推荐”回车等价，不走「待你定」弹层的 `startTurn`；输入框一有字就收起，清空后重新出现。Tab（输入框为空且聚焦）只填入第一个按钮的内容，第一个是「按推荐」时也不发送；Esc 本轮收起。回复里有两组以上选项（同一标号出现两次以上），或只有「待你定」段没有标号时，只给「按推荐」。规则按钮只读回复文字，0ms 出现，不调模型；服务端的上下文顾问另给 1–3 枚可多选切换的虚线建议按钮。受上游 Labs「下一步建议」开关 `promptSuggestionsEnabled` 控制，不新增设置项。

### 前端结构（`promptAssistant/choices/`）

- `replyOptions.ts`：从回复 Markdown 提取选项；推荐项排第一，最多 4 项。
- `composerChoices.logic.ts`：选项转按钮、`formatAdvisorSelection` 多选文本拼装，以及 `isAdvisorItemChoice` / `isAdvisorMergeChoice` 区分；取最新一轮最后一条非 commentary 的助手回复。
- `useComposerChoices.ts`：最新一轮完成后才订阅回复文字（流式输出时输入框不跟着重渲染），并托管顾问多选状态与快捷条可见性（按环境、线程、`runId` 与 `promptSuggestion` 隔离，换轮清零，输入框等于最后生成文本或为空时保持显示）。
- `composerChoiceDismissal.ts`：Esc 的收起状态，按环境加轮次记，跨重挂载保留。
- `ComposerChoiceStrip.tsx`：快捷条。规则按钮用 `Button size="xs" variant="outline"`；顾问按钮与「全部」按钮为切换按钮（`aria-pressed`，选中态为实线边框与 accent 背景）；Tab/Esc 在文档上以捕获阶段监听，只处理焦点在本输入框编辑区且无修饰键、非输入法组字的按键；卸载时清空多选状态。
- `promptAdvisorPayload.cn.ts`：顾问编码串的解析（与服务端同一协议，见下）。

### 上下文顾问

每个完成的 run 之后，服务端用本机 Antigravity 看最近对话，给 0–3 条建议；模型默认自动优选 Neon（`low` 思考档，回退 Hydrogen、3.8 Flash、实例默认），可在设置页改。所有 provider（Claude、Codex、Grok、Antigravity）的回合都由它统一采样；本机有可用顾问时上游各 adapter 自带的下一句预测一律关闭（`promptSuggestions` 传 false），避免每轮双份请求，没有 Antigravity 时自动退回上游原生灰字。

- **零合同编码**：不改 `packages/contracts`，结构化建议塞进现有 `promptSuggestion.text`：前缀 `\u001et3cn-advisor:v1:` 加 JSON `{"items":[{"kind":"challenge|next|angle","label":"≤24 字符","fill":"≤240 字符"}]}`。前缀常量两端各存一份（`apps/server/src/textGeneration/promptAdvisor.cn.ts`、`promptAssistant/choices/promptAdvisorPayload.cn.ts`），改版本号要两处一起改。带前缀但 JSON 损坏解成空列表，仍视为协议串，不会落进灰字占位；不带前缀的串照旧是上游灰字。
- **融合规则**（`mergeComposerChoices`、`formatAdvisorSelection`）：规则有按钮时原样保留，再最多追加 1 枚顾问按钮（优先 `challenge`，其次 `angle`，忽略 `next`），徽标 `盲点`/`换角度`（英文 fill 用 `Blind spot`/`Angle`）；规则为空时顾问的 1–3 枚全部展示，徽标 `反问`/`推进`/`换角度`（英文 `Challenge`/`Next`/`Angle`），顾问在 2 枚及以上时末尾追加一枚切换按钮（中文建议用 `全部` + `合并 N 条`，英文全部不含 CJK 时用 `All` + `Merge N`），未全选时点它选中全部、已全选时点它全部取消。选中 1 枚时输入框实时填入该条 `fill` 原文；选中 2 枚及以上时按按钮显示顺序生成编号文本（选中的建议含 CJK 用 `请逐条回应以下几点：\n1. ...`，否则用 `Please respond to each point:\n1. ...`）；全部取消则清空输入框。组件容器的 `aria-label`（`Reply options` / `回复里的选项`）接入上游 `gt-react` 词表随界面语言切换。顾问按钮未选中时为虚线边框，选中为实线边框与 accent 背景，悬停看 `fill` 全文。
- **交互**：顾问按钮一律只实时填入不发送，哪怕 `fill` 恰好是「按推荐」；只要输入框内容仍等于快捷条最后生成的文本或为空，快捷条保持显示，用户手动改动文字后收起（退格不重开，清空后重新出现并回到未选中态）；在已有顾问预览时点击规则按钮会整段替换输入框（或按推荐直接发送）。发送只属于规则里的「按推荐」。Tab 仍填第一枚（若首枚为顾问按钮则等价于只选中第一枚），Esc 收起本轮并清零选择，新的一轮（`runId` 变化）选择状态清零。
- **四阶段镜片**：提示词把四套成熟 Skill 的方法论蒸馏成旁观镜片，由顾问按对话所处阶段自己挑一两个用，多数轮次一个都用不上：决策前沿与减法（grilling + keel：只问最能改变结果的一个问题并给推荐默认、哪些可砍、边界与失败路径）、根因先于补丁（systematic-debugging：先复现、读全错误、一次一个假设）、改动影响面实证（blast-radius：diff 外的调用方、存储格式、配置、文档，要真代码证据）。三个开关对应设置页三个镜片；全关等于原有提示词。需要真干活时（深度拷问、复现、查影响面）`next` 的 `fill` 写成一句自然语言指令，把有工具的主 Agent 推进对应工作流，不写斜杠命令或 Skill 名（四家 provider 通用）。已有显式选项时不出杠杆，仍只允许 0–1 条 `challenge`/`angle`、绝不出 `next`。
- **解析失败不再静默**：`readPromptAdvisorOutput` 把模型原始输出读成「`Unparseable`（不是约定的 `{ items: [...] }`，带最多 240 字符摘录）」或「`Parsed`（收到几条、规则丢了几条）」，`sanitizePromptAdvisorOutput` 仍是它的薄封装。正常回合遇到 `Unparseable` 仍安全返回 `null`、不出按钮，但把 `Advisor output was not valid JSON.` 写进顾问的 `lastError`，状态条可见，下一次成功采样清掉；合法空数组与全被过滤都不算错误。试跑遇到 `Unparseable` 直接回 502 与摘录；JSON 合法但条目全被规则过滤时回 200、`items: []` 与 `dropped`，界面写明“被安全规则过滤”，不显示成“没有建议”。
- **提示词结构**：可替换的只有开头的“思考指令”（内置文本加镜片，或设置里的全文覆盖，再接补充指令）；JSON 输出格式、`label ≤ 24` 与 `fill ≤ 240`、`hasExplicitChoices` 两行、禁迎合句与 `Delegated task`、跟随末条用户消息语言、`Each request is independent` 和对话定界符永远由代码包裹，清洗函数照旧兜底。设置页展示的“当前生效提示词”与真实请求用同一个构造函数，只是把对话换成占位。
- **服务端结构**：`textGeneration/promptAdvisor.cn.ts`（提示词、清洗、温进程采样器：隔离边界同 `AntigravityTextGeneration`，单次 30 秒超时，出错、超时或被中断立刻重建）、`promptAdvisorConfig.cn.ts`（配置类型、校验、默认值、落盘与进程内当前值）、`promptAdvisorRegistry.cn.ts`（进程内注册表，`AntigravityDriver` 启用时注册、Scope 关闭时注销；按角色解析实例，显式指定的实例不可用时回退自动优选，状态里同时给出请求与实际实例）、`orchestration-v2/promptAdvisorService.cn.ts`（订阅已提交的 `run.updated`，同线程新 run 开始即取消旧采样，写回 `promptSuggestionStore`）。
- **跳过条件**：开关关、无可用顾问、已删除线程、子会话（`relationshipToParent === "subagent"`）与委派线程（`delegatedFrom` 非空）、续跑与委派任务的 run、唤醒与 `/compact` 触发的 run、采样结束时最新 run 已变；分叉线程（`relationshipToParent === "fork"`）照常采样。
- **末条回复已有显式选项**（两个以上标号或「待你定」段，`hasExplicitReplyChoices`）：顾问只允许给 0–1 条 `challenge`/`angle`，没有真盲点就不出。

## 输入框提示词优化（Prompt Refiner）

点输入框左下角的魔棒按钮（或在编辑区按 Cmd+Shift+Y / Ctrl+Shift+Y）在发送前原地打磨：用当前仓库的上下文把草稿或选中的局部片段改写得更清楚，结果先出现在输入框正文上方的预览卡，点「应用替换」才改草稿，从不自动发送。应用后工具栏里留一个「撤销优化」，下一次编辑前有效。

### 三档模式

每档的指令文本可在设置页微调：非空的 `modeOverrides[mode]` 替换内置指令（其余规则、语言跟随、独立请求声明与草稿定界符仍由代码包裹），恢复默认即清空；设置页还能用内置示例草稿试跑一次（可直接试跑未保存的草稿，不碰线上温槽）。

预览卡顶部的胶囊，切换后立即用最初那份草稿快照重新优化；上次选的模式在本页内沿用，默认结构清晰。

- 结构清晰（`structured`）：理清目标、维度、边界与期望输出，落到当前仓库的具体位置；禁止“你是一位资深架构师…”“请用清晰的 Markdown…”一类空泛套话。
- 大胆发散（`bold`）：保留并放大用户的锋芒，逼出彼此冲突的激进视角与会推翻的假设，要求写出收益上限与风险，不要折中。
- 工程交付（`scoped`）：补齐范围、不做什么、验收标准，以及先核实再改动。

有选区时只返回选区的替换文本（提示词里用 `<composer_before>` / `<composer_selection>` / `<composer_after>` 切分，与语音转写后处理同一结构），要求与前后文自然衔接；无选区返回整段优化稿。输出语言跟随草稿，仓库文档里的“用中文回复”之类指令不影响它。

### 路由与服务端

`POST /api/cn/prompt-refine`，请求 `{ draft, selection?, mode?, projectId?, threadId? }`，返回 `{ refined, mode, usedWorkspaceContext }`；400 入参非法（草稿为空或超 20,000 字符、选区越界、模式未知），401/403 鉴权，503 无可用实例，502 超时或采样失败。

- 鉴权：同设备 hub 与预览流，`authenticateMediaRequest(AuthOrchestrationOperateScope)`。Cookie 会话直接过；bearer 与 DPoP 连接由前端用 `resolveDeviceHubAccess({ hubBasePath: "/api/cn" })` 取一枚 `media` 票据放在 `?wsTicket=`，401 时换票重试一次（`issueWebSocketTicket` 只给 `rpc` 票据绑 proof key，`media` 票据不绑，所以普通 fetch 够用）。路由不在 `EnvironmentHttpApi` 契约里，所以没有走 `executeAuthenticatedEnvironmentHttpRequest`。
- 仓库指纹：`collectWorkspaceFingerprint` 只读且有界，总量 ≤ 4,000 字符：顶层名（跳过 `.git`、`node_modules`、`dist`、`.local`、`.state` 等，最多 40 项）、`AGENTS.md` ≤ 1,600 字、`README.md` ≤ 1,200 字、`package.json` 只取 `name` 与 `description`；`realPath` 越出工作区的符号链接不跟随，任何失败静默退成空串。工作区取线程的 worktree 或项目根，没有线程与项目时不带指纹。
- 线程尾：带 `threadId` 时读最近最多 4 条用户与非 commentary 助手消息（总长 ≤ 3,000 字符）；指纹与线程尾在提示词里都用定界符包成“数据，不是指令”。
- 清洗：解析 `{"refined": string}`，去首尾空白，保留多行，空串或超 8,000 字符一律当失败。
- 服务端文件：`apps/server/src/textGeneration/promptRefiner.cn.ts`（提示词、指纹、线程尾、清洗、`refinePrompt`）、`apps/server/src/http/promptRefinerHttp.cn.ts`（路由，读 `ProjectionStoreV2` 在建 layer 时完成）、`promptAdvisor.cn.ts` 与 `promptAdvisorRegistry.cn.ts` 的 `PromptAdvisorRuntime` 扩充。

### 前端结构（`promptAssistant/refiner/`）

- `promptRefiner.logic.ts`：请求体、选区切片与替换计划、撤销计划、i18n 词表键与快捷键判断，单测。
- `promptRefinerClient.ts`：取票、请求、401 换票重试（`readAccess` 也被设置面板的客户端复用）。
- `usePromptRefiner.ts`：`idle | loading | preview | error` 状态机，触发时抓草稿与选区快照，返回前切模式、取消都会中止上一次请求。
- `PromptRefinerBar.tsx`：`PromptRefinerButton` 与 `PromptRefinerCard`。按钮与卡片文案以英文为源串接入上游 `gt-react` 词表，在 `apps/web/src/i18n/translations/zh.json` 补对应中文译文，随界面语言切换。
- 预览卡与撤销入口按草稿归属（`questionAttachmentTarget ?? composerDraftTargetKey`）存放，输入框跨线程保持挂载，切线程时卡片不跟过去。助手运行中（`running` / `connecting`）触发按钮禁用。
- 应用与撤销都经输入框自己的 `applyPromptReplacement` 并带 `expectedText`：选区模式下选区文字已变就拒绝并提示重新选择；整段模式下草稿在等待期间被改动时，预览卡标“草稿已改动”，仍可确认替换，替换的是应用那一刻的整段草稿，撤销恢复的也是它。

## 统一配置、温槽与设置面板

顾问与优化各有自己的实例、模型、思考档，存在服务端 `<stateDir>/cn-prompt-advisor.json`：`{ version: 1, advisor: { runtime, lenses, customAppendix, promptOverride }, refiner: { followAdvisorRuntime, runtime, modeOverrides } }`，`null` 表示自动优选。写入先写 `.tmp` 再改名；文件缺失用默认，损坏、缺字段或超长一律静默用默认且不覆写原文件（用户下次保存才会替换）；服务端启动建路由层时即加载。

- **温进程**：不另起后台进程。`PromptAdvisorSampler` 之外新增 `PromptAdvisorRuntime extends PromptAdvisorSampler`，多 `runPrompt`（优化角色入口）、只读的 `inspect()` 和按签名清理的 `retain()`/`release()`；`makeAntigravityPromptAdvisorSampler` 返回它，注册表存放与返回的都是这个类型。隔离边界（无工具、无文件读写、无终端、写文件检查、30 秒超时、出错即销毁）、5 分钟空闲回收与 20 次复用上限对每个槽都一样；自动优选仍是 Neon → Hydrogen → 3.8 Flash → 实例默认、`low` 思考档。每个提示词都声明“本次请求独立，忽略此前内容”。
- **温槽按目标共享或隔离**：每个 Antigravity 实例的运行时内部最多两个温槽，槽键是角色“请求的”模型加思考档（实际落到哪个模型要起进程才知道，所以冷态不能按解析后的模型匹配）。优化默认“跟随顾问”：两个角色请求相同就共用一个进程、一个锁和一份 `N/20` 复用计数；关闭跟随并配了不同的目标时各用各的槽，互不切模型、互不抢锁，优化槽按需懒启动。
- **保存时精准释放**：`PUT` 先销毁“已无任何角色引用”的槽（不是“变更角色的槽”，所以顾问从共享槽移走时不会误杀仍指向它的独立优化槽），再对提示词有变化的角色释放它当前签名的槽（顾问的镜片、补充指令、全文覆盖，或优化的三档指令），让下一次从干净会话开始，免得旧会话里的历史干扰新提示词；另一个角色用不同签名时绝不碰它，两边共用一个槽时任一边改了提示词就清掉这个共享槽。正在跑提示词的槽只摘掉标记，随这次请求结束释放。只改模型或不改动则不释放别的。
- **实时状态不唤醒进程**：运行时的 `inspect()` 只读内存，不启动进程；汇报每个角色的 `state`（`warm` / `idle` / `unavailable`）、实际命中的实例、`activeModel`、`activeThinking`、`modelSource`（`live`：来自跑过的进程，空闲回收后仍记得；`preset`：冷态内置列表，含 `gemini-4-neon` / `hydrogen` / `carbon` / `argon` / `gemini-3.8-flash`）、可选项、`uses/maxUses`、`lastSampleAt`、`lastDurationMs`、`lastError`（按角色记，出错销毁槽后仍保留），以及两个角色是否共用一个槽。
- **路由**（都在 `promptRefinerHttp.cn.ts` 的 `promptRefinerRouteLayer` 里，`server.ts` 零新增，鉴权同 `prompt-refine`）：`GET`/`PUT /api/cn/prompt-advisor/config` 返回 `{ config, status, previews, defaults }`（没有任何可用实例时也是 200，状态为 `unavailable`；`PUT` 整份替换，入参不合法回 400，保存失败回 500）；`POST /api/cn/prompt-advisor/test-run`，入参 `{ role: "advisor", scenario: "vague" | "debugging" | "explicit_choices" }` 或 `{ role: "refiner", mode? }`，可再带 `config`（未保存的整份草稿，同样校验，不合法回 400）。用内置的三段中文示例对话或一段示例草稿真实跑一遍：不带 `config` 用已生效配置并走温槽；带 `config` 时不写盘、不改进程内配置，也不动任何温槽、复用计数与活动记录，而是在 `runIsolated` 起一个一次性进程（单独一把锁、跑完即关）按草稿的实例、模型、思考档与提示词跑。返回 `{ role, durationMs, draft, ran: { resolvedInstanceId, activeModel, activeThinking }, items + dropped | refined, status }`，`status` 始终是已保存配置的状态；失败回 503/502 与 `{ error, status }`。
- **前端**（`promptAssistant/settings/`）：`promptAdvisorConfig.logic.ts` 类型、校验、状态文案；`promptAdvisorConfigClient.ts` 取票并在 401 时换票重试一次，复用 `refiner/promptRefinerClient.ts` 的 `readAccess`；`usePromptAdvisorSettings.ts` 加载、保存排队与试跑；`PromptAdvisorSettingsSection.tsx` 只收 `environmentId`；`promptAdvisorSettings.testing.ts` 为测试夹具。挂在 fork 自有的 `apps/web/src/pluginHost/PluginsSettings.tsx` 的「App rail」之后、「Plugins」之前，不碰上游 `LabsSettingsPanel.tsx`、`SettingsSidebarNav.tsx` 与 `packages/contracts/src/settings.ts`。
- **面板行为**：分上下两块：「上下文顾问」（实时状态条、实例/模型/思考档、三个镜片开关、补充指令、全文覆盖、当前完整生效提示词、用示例对话试跑）与「提示词优化」（实时状态条并标明共用还是独立温槽、跟随顾问开关，关闭后才出现独立选择器、三档提示词查看与微调、用示例草稿试跑）。所有改动先进表单草稿，底部浮出「未保存」栏（保存 / 放弃），点保存才整份 `PUT`；保存期间控件禁用；有草稿时「用示例试跑」仍可点，直接把草稿作为 `config` 传给 `test-run`，结果旁标注“按你尚未保存的草稿试跑”，满意后再保存；提示词预览与实时状态在保存前仍显示已保存的设置。覆盖框下写明 JSON 输出格式、长度上限与定界符由应用固定，不用自己写。只在挂载、保存后和点刷新时拉状态，不轮询。日后迁入 `#40222` 插件时整块搬走，只要把 `PromptAdvisorSettingsSection` 注册成设置位置的页面。
- **未覆盖**：真实 Neon 采样与真实设置页走查没有在自动测试里做（只用替身运行时与 mock 客户端）；手机端未接入；`evals/` 目前没有覆盖顾问与优化提示词的用例，改措辞靠单测里的断言（优化的 `promptRefiner.cn.test.ts` 断言反八股禁令、语言跟随、独立请求声明与选区切分）与设置页的试跑。

## 会话推进小精灵（影子观察模式）

- **现行形态**：Phase 1 为纯影子观察模式（`mode: "shadow"`），默认关闭（`sprite.enabled = false`）。在上下文顾问完成采样并登记内存快照（128 条 LRU `sessionSpriteRegistry.cn.ts`）后，后台 60s 轮询按 `scanIntervalMinutes` / `idleMinutes` 评估闲置线程，仅产出结构化判定与非授权草稿写入 `<stateDir>/cn-session-sprite.jsonl`，物理只读、绝不发送消息或修改任何线程状态。
- **四道闸门与确定性二次护栏**：
  1. **闸门 1（全局静默与小时限流）**：`quietHoursEnabled` 启用时按本地时钟检查 `quietStartHour`..`quietEndHour`（支持跨午夜）；近 1 小时 `would_advance` 达 `maxGlobalPerHour` 时跳过。
  2. **闸门 2（13 项线程硬门）**：`evaluateThreadEligibility` 检查线程有效性、静止时长、标题屏蔽关键词（`blockedTitleKeywords`，含 `GWH-`、`NSNET-`、`ETECH`、`SIR`、`work`、`141`、`CostMan`、`台式机`、`定时任务`、`巡检`、`每周维护`、`每日同步`）、工作区路径是否命中 `work/`、`scheduledTaskId`、子会话/委派、已有活跃 run、待确认输入、`needsYou`、已由本次人类回合推进达 `maxPerThreadPerHumanTurn` 等条件，拦截即记 `blocked_thread`，零模型调用。
  3. **闸门 3（Neon 分级与二次护栏）**：仅对通过闸门 2 的线程调 `PromptAdvisorRuntime.runPrompt` 按 A/B/C 分级，并过确定性正则 `matchesAuthOrWriteGuard` 二次降级（即使模型误标 A，命中决策/立项/建仓/推送/改 hosts/删除等模式仍强行降为 C 拦截）。
  4. **非授权协议头**：放行条目（`keptItems`）拼装 `draftMessage` 时强制带前缀 `SESSION_SPRITE_NON_AUTH_HEADER`（`[自动推进·只读核验｜非用户授权，禁做方向拍板/写操作/推送/公司侧改动]`），提示仅记录观察结果。
- **账本与 HTTP 端点**：
  - `GET /api/cn/prompt-advisor/sprite/ledger`：返回 `{ summary, entries, ledgerPath }`（最新 30 条倒序）。
  - `POST /api/cn/prompt-advisor/sprite/scan`：接收可选 `{ bypassQuietHours?, bypassIdle? }`，手动触发扫描（与后台扫描共用 `scanLock` 互斥）并返回 `{ scanned, wouldAdvance, blocked, errors, summary, entries }`。
  - 前端在 `promptAssistant/settings/` 拆出独立 `SessionSpriteSettingsBlock.tsx` 与 `useSessionSpriteLedger.ts`，在 `PromptAdvisorSettingsSection.tsx` 底部极薄挂载，沿用统一草稿保存与 `cn-prompt-advisor.json`（缺失 `sprite` 字段向后兼容回退默认值）。
- **零上游逻辑改动与未覆盖项**：服务端逻辑全在 `.cn.ts` / `.cn.test.ts` 中，前端设置全在 `pluginHost/promptAssistant/settings/` 下（仅同步多语言词表 `apps/web/src/i18n/translations/*.json`）；未在自动测试中连接真实 Antigravity/Neon 进程或启动真实桌面端走查。

## 上游薄接线与同步清单

### 上游文件改动（相对 `2f24a064c9`）

`apps/web/src/components/chat/ChatComposer.tsx`：最初接入插入 24 行（含 2 行 import）、改行 2 行；上下文顾问再加 1 行 import、`useComposerChoices` 多传 `promptSuggestion`、`offeredPromptSuggestion` 多一个 `isPromptAdvisorPayload` 条件；多选切换再在接线处净增减 +7/-8 行（`useComposerChoices` 多传 `prompt`、`showComposerChoices` 改读 `composerChoices.visible`、`<ComposerChoiceStrip>` 改传 `controller` 并整段替换输入框）；提示词优化另有 2 行 import、13 行 `usePromptRefiner(...)`、正文上方 `<PromptRefinerCard>`，以及底部左侧把附件按钮包进 `me-2 flex` 容器并加 `<PromptRefinerButton>`（原来没有附件按钮时该容器不渲染，现在始终渲染）。目录统一到 `promptAssistant/` 只改 import 路径，不增删业务逻辑行。

服务端上游薄接线（配置与设置面板不增加上游行数）：

| 文件                        | 改动                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts` | 1 行 import，`layerMakeRoutes` 里加 `promptRefinerRouteLayer.pipe(Layer.provide(ProjectionStoreV2.layer))`（路由在建 layer 时取 `ProjectionStoreV2`，其余服务沿用全局提供）        |
| `AntigravityDriver.ts`      | 创建采样器并注册顾问（`if (enabled)` 块，约 8 行）                                                                                                                                 |
| `ProviderSessionManager.ts` | 创建 `makePromptAdvisorService`、把 `promptSuggestions` 改成 `promptAdvisor.nativeSuggestions`，并把 `prompt_suggestion.updated` 的存储逻辑抽成 `storePromptSuggestion` 供两处共用 |

测试基础设施：`apps/web/test/fakeEnvironment.ts` 多一个 `promptSuggestion` 选项和对应订阅处理（6 行）。

`ChatComposer.tsx` 的接线位置：

| 位置                                                    | 动作                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| import 区（`:305-316`）                                 | 插入 `ComposerChoiceStrip`、`useComposerChoices`、`isPromptAdvisorPayload`、`PromptRefinerBar`、`usePromptRefiner` 的 import                                                     |
| `const promptSuggestionSlot =`（约 `:2557`）            | 原 `offeredPromptSuggestion` 条件保留在 `promptSuggestionSlot`，`? promptSuggestion` 改成 `? { ghost: promptSuggestion }`                                                        |
| 其后（`:2569-2598`）                                    | 调用 `useComposerChoices(..., promptSuggestion, prompt)`、`showComposerChoices` 读 `composerChoices.visible`，`offeredPromptSuggestion` 过滤顾问串；其后 `usePromptRefiner(...)` |
| 输入框正文 `data-chat-composer-body` 之前（约 `:3861`） | 插入 `<ComposerChoiceStrip controller={composerChoices} ...>`（`onPick`/`onSend` 按 `0..promptRef.current.length` 整段替换）与 `<PromptRefinerCard>`                             |
| 底部左侧工具栏                                          | 附件按钮包进 `me-2 flex` 容器并加 `<PromptRefinerButton>`                                                                                                                        |

快捷条出现时灰字占位与 Tab 提示一并让位；上游的 Tab 填灰字、Esc 收灰字仍只管灰字。

### 同步上游时

- 上游改了 `offeredPromptSuggestion` 的条件：条件原样留在 `promptSuggestionSlot` 里，不必另抄。
- 上游改了 `usePromptSuggestion` 或 `offeredPromptSuggestion` 的出口：编码串的挡板只有 `ChatComposer.tsx` 里 `isPromptAdvisorPayload` 那一个条件，同步后要核对它仍在灰字之前生效，浏览器测试的“编码串损坏”用例会失败提醒。
- 上游改了 `promptSuggestions` 在 `ProviderSessionManager.ts` 传给 `openSession` 的位置：保持传 `promptAdvisor.nativeSuggestions`，否则有顾问时每轮会再被原生预测采样一次。
- 上游改了 `prompt_suggestion.updated` 的存储或 `MAX_PROMPT_SUGGESTIONS`：顾问通过 `storePromptSuggestion` 写同一个存储，两条路径要保持一致。
- 手机宽度的收起态（`isComposerCollapsedMobile`）不显示快捷条，点开输入框后才出现。
- Esc 收起快捷条时不收灰字；灰字在没有快捷条时照旧。
- 路由层建 layer 时多取一个 `ServerConfig`（拿 `stateDir` 并加载 `cn-prompt-advisor.json`）与 `Path`，二者由 `server.ts` 全局提供，不需要改接线；上游若让路由层拿不到 `ServerConfig`，HTTP 测试的 `serve()` 会先失败。
- `ChatComposer.tsx` 冲突：保留上游改动，再把上面的接线补回；`readDraft` 与 `replaceRange` 只依赖 `readComposerSnapshot`、`composerEditorRef.readSelectionRange` 与 `applyPromptReplacement(start, end, text, { expectedText })` 三个现成入口。
- 快捷键用 Mod+Shift+Y：上游默认键位里 `mod+shift+e` 已是 `composer.effort`（`packages/shared/src/keybindings.ts:119`），任务书原定的 E 会冲突；同一个组合键测试在 E 下超时、改 Y 后通过。它是文档级捕获监听，不进键位系统，所以不能在设置里改键；上游若占用 `mod+shift+y` 要改 `isRefineShortcut` 与按钮提示。
- 上游改了 `authenticateMediaRequest` 或 `resolveDeviceHubAccess`：两端必须同步，路由和客户端共用这套票据。
- 取消或加载中切模式会中断服务端正在跑的请求，温进程按既有语义销毁，下一次优化是冷启动。
- 内置提示词与清洗文字只在 `promptRefiner.cn.ts`（用户在设置页覆盖的指令存在配置里），改措辞时先跑 `promptRefiner.cn.test.ts`。
