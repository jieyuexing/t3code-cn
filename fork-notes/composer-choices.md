# 输入框决策快捷条

回复里列了带标号的选项（甲乙丙丁、A–D）时，输入框编辑区上方给每个选项一个按钮，外加「按推荐」。点选项按钮只把标号填进输入框、不发送，光标在末尾（用户常接着补一句）；点「按推荐」直接把这三个字作为一条消息发出，走输入框自己的发送路径（`submitComposer`），与空输入框里打“按推荐”回车等价，不走「待你定」弹层的 `startTurn`；输入框一有字就收起，清空后重新出现。Tab（输入框为空且聚焦）只填入第一个按钮的内容，第一个是「按推荐」时也不发送；Esc 本轮收起。回复里有两组以上选项（同一标号出现两次以上），或只有「待你定」段没有标号时，只给「按推荐」。规则按钮只读回复文字，0ms 出现，不调模型；服务端的上下文顾问另给 1–3 枚可多选切换的虚线建议按钮（见「上下文顾问」）。受上游 Labs「下一步建议」开关 `promptSuggestionsEnabled` 控制，不新增设置项。

## 现行结构

全在 `apps/web/src/pluginHost/needsYou/`，和「待你定」弹层共用 `replyPending.ts` 的 Markdown 清理（`stripMarkdown` 由此导出）：

- `replyOptions.ts`：从回复 Markdown 提取选项；推荐项排第一，最多 4 项。
- `composerChoices.logic.ts`：选项转按钮、`formatAdvisorSelection` 多选文本拼装，以及 `isAdvisorItemChoice` / `isAdvisorMergeChoice` 区分；取最新一轮最后一条非 commentary 的助手回复。
- `useComposerChoices.ts`：最新一轮完成后才订阅回复文字（流式输出时输入框不跟着重渲染），并托管顾问多选状态与快捷条可见性（按环境、线程、`runId` 与 `promptSuggestion` 隔离，换轮清零，输入框等于最后生成文本或为空时保持显示）。
- `composerChoiceDismissal.ts`：Esc 的收起状态，按环境加轮次记，跨重挂载保留。
- `ComposerChoiceStrip.tsx`：快捷条。规则按钮用 `Button size="xs" variant="outline"`；顾问按钮与「全部」按钮为切换按钮（`aria-pressed`，选中态为实线边框与 accent 背景）；Tab/Esc 在文档上以捕获阶段监听，只处理焦点在本输入框编辑区且无修饰键、非输入法组字的按键；卸载时清空多选状态。

## 上下文顾问

每个完成的 run 之后，服务端用本机 Antigravity 的 Neon（`low` 思考档，回退 Hydrogen、3.8 Flash、实例默认）以“批判性顾问”口吻看最近对话，给 0–3 条建议。所有 provider（Claude、Codex、Grok、Antigravity）的回合都由它统一采样；本机有可用顾问时上游各 adapter 自带的下一句预测一律关闭（`promptSuggestions` 传 false），避免每轮双份请求，没有 Antigravity 时自动退回上游原生灰字。

- **零合同编码**：不改 `packages/contracts`，结构化建议塞进现有 `promptSuggestion.text`：前缀 `\u001et3cn-advisor:v1:` 加 JSON `{"items":[{"kind":"challenge|next|angle","label":"≤24 字符","fill":"≤240 字符"}]}`。前缀常量两端各存一份（`apps/server/src/textGeneration/promptAdvisor.cn.ts`、`promptAdvisorPayload.cn.ts`），改版本号要两处一起改。带前缀但 JSON 损坏解成空列表，仍视为协议串，不会落进灰字占位；不带前缀的串照旧是上游灰字。
- **融合规则**（`mergeComposerChoices`、`formatAdvisorSelection`）：规则有按钮时原样保留，再最多追加 1 枚顾问按钮（优先 `challenge`，其次 `angle`，忽略 `next`），徽标 `盲点`/`换角度`（英文 fill 用 `Blind spot`/`Angle`）；规则为空时顾问的 1–3 枚全部展示，徽标 `反问`/`推进`/`换角度`（英文 `Challenge`/`Next`/`Angle`），顾问在 2 枚及以上时末尾追加一枚切换按钮（中文建议用 `全部` + `合并 N 条`，英文全部不含 CJK 时用 `All` + `Merge N`），未全选时点它选中全部、已全选时点它全部取消。选中 1 枚时输入框实时填入该条 `fill` 原文；选中 2 枚及以上时按按钮显示顺序生成编号文本（选中的建议含 CJK 用 `请逐条回应以下几点：\n1. ...`，否则用 `Please respond to each point:\n1. ...`）；全部取消则清空输入框。组件容器的 `aria-label`（`Reply options` / `回复里的选项`）接入上游 `gt-react` 词表随界面语言切换。顾问按钮未选中时为虚线边框，选中为实线边框与 accent 背景，悬停看 `fill` 全文。
- **交互**：顾问按钮一律只实时填入不发送，哪怕 `fill` 恰好是「按推荐」；只要输入框内容仍等于快捷条最后生成的文本或为空，快捷条保持显示，用户手动改动文字后收起（退格不重开，清空后重新出现并回到未选中态）；在已有顾问预览时点击规则按钮会整段替换输入框（或按推荐直接发送）。发送只属于规则里的「按推荐」。Tab 仍填第一枚（若首枚为顾问按钮则等价于只选中第一枚），Esc 收起本轮并清零选择，新的一轮（`runId` 变化）选择状态清零。
- **服务端结构**：`textGeneration/promptAdvisor.cn.ts`（提示词、清洗、温进程采样器：隔离边界同 `AntigravityTextGeneration`，5 分钟空闲销毁、最多复用 20 次、单次 30 秒超时、出错、超时或被中断立刻重建）、`promptAdvisorRegistry.cn.ts`（进程内注册表，`AntigravityDriver` 启用时注册、Scope 关闭时注销，优先 id 为 `antigravity` 的实例）、`orchestration-v2/promptAdvisorService.cn.ts`（订阅已提交的 `run.updated`，同线程新 run 开始即取消旧采样，写回 `promptSuggestionStore`）。
- **跳过条件**：开关关、无可用顾问、已删除线程、子会话（`relationshipToParent === "subagent"`）与委派线程（`delegatedFrom` 非空）、续跑与委派任务的 run、唤醒与 `/compact` 触发的 run、采样结束时最新 run 已变；分叉线程（`relationshipToParent === "fork"`）照常采样。
- **末条回复已有显式选项**（两个以上标号或「待你定」段，`hasExplicitReplyChoices`）：顾问只允许给 0–1 条 `challenge`/`angle`，没有真盲点就不出。

## 上游文件改动（相对 `2f24a064c9`）

`apps/web/src/components/chat/ChatComposer.tsx`：最初接入插入 24 行（含 2 行 import）、改行 2 行；上下文顾问再加 1 行 import、`useComposerChoices` 多传 `promptSuggestion`、`offeredPromptSuggestion` 多一个 `isPromptAdvisorPayload` 条件；多选切换再在接线处净增减 +7/-8 行（`useComposerChoices` 多传 `prompt`、`showComposerChoices` 改读 `composerChoices.visible`、`<ComposerChoiceStrip>` 改传 `controller` 并整段替换输入框）。

服务端上游薄接线：`AntigravityDriver.ts` 创建采样器并注册顾问（`if (enabled)` 块，约 8 行）；`ProviderSessionManager.ts` 创建 `makePromptAdvisorService`、把 `promptSuggestions` 改成 `promptAdvisor.nativeSuggestions`，并把 `prompt_suggestion.updated` 的存储逻辑抽成 `storePromptSuggestion` 供两处共用。

测试基础设施：`apps/web/test/fakeEnvironment.ts` 多一个 `promptSuggestion` 选项和对应订阅处理（6 行）。

| 位置                                                    | 动作                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| import 区（`:305-312`）                                 | 插入 `ComposerChoiceStrip`、`useComposerChoices`、`isPromptAdvisorPayload` 三行                                                                    |
| `const promptSuggestionSlot =`（约 `:2557`）            | 原 `offeredPromptSuggestion` 条件保留在 `promptSuggestionSlot`，`? promptSuggestion` 改成 `? { ghost: promptSuggestion }`                          |
| 其后（`:2569-2598`）                                    | 调用 `useComposerChoices(..., promptSuggestion, prompt)`、`showComposerChoices` 读 `composerChoices.visible`，`offeredPromptSuggestion` 过滤顾问串 |
| 输入框正文 `data-chat-composer-body` 之前（约 `:3861`） | 插入 `<ComposerChoiceStrip controller={composerChoices} ...>`，`onPick`/`onSend` 按 `0..promptRef.current.length` 整段替换                         |

快捷条出现时灰字占位与 Tab 提示一并让位；上游的 Tab 填灰字、Esc 收灰字仍只管灰字。

## 同步上游时

- 上游改了 `offeredPromptSuggestion` 的条件：条件原样留在 `promptSuggestionSlot` 里，不必另抄。
- 上游改了 `usePromptSuggestion` 或 `offeredPromptSuggestion` 的出口：编码串的挡板只有 `ChatComposer.tsx` 里 `isPromptAdvisorPayload` 那一个条件，同步后要核对它仍在灰字之前生效，浏览器测试的“编码串损坏”用例会失败提醒。
- 上游改了 `promptSuggestions` 在 `ProviderSessionManager.ts` 传给 `openSession` 的位置：保持传 `promptAdvisor.nativeSuggestions`，否则有顾问时每轮会再被原生预测采样一次。
- 上游改了 `prompt_suggestion.updated` 的存储或 `MAX_PROMPT_SUGGESTIONS`：顾问通过 `storePromptSuggestion` 写同一个存储，两条路径要保持一致。
- 手机宽度的收起态（`isComposerCollapsedMobile`）不显示快捷条，点开输入框后才出现。
- Esc 收起快捷条时不收灰字；灰字在没有快捷条时照旧。
