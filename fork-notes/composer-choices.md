# 输入框决策快捷条

回复里列了带标号的选项（甲乙丙丁、A–D）时，输入框编辑区上方给每个选项一个按钮，外加「按推荐」。点按钮只把标号填进输入框、不发送，光标在末尾；输入框一有字就收起，清空后重新出现。Tab（输入框为空且聚焦）填入第一个按钮，Esc 本轮收起。回复里有两组以上选项（同一标号出现两次以上），或只有「待你定」段没有标号时，只给「按推荐」。只读回复文字，不调模型。受上游 Labs「下一步建议」开关 `promptSuggestionsEnabled` 控制，不新增设置项。

## 现行结构

全在 `apps/web/src/pluginHost/needsYou/`，和「待你定」弹层共用 `replyPending.ts` 的 Markdown 清理（`stripMarkdown` 由此导出）：

- `replyOptions.ts`：从回复 Markdown 提取选项；推荐项排第一，最多 4 项。
- `composerChoices.logic.ts`：选项转按钮；取最新一轮最后一条非 commentary 的助手回复。
- `useComposerChoices.ts`：最新一轮完成后才订阅回复文字（流式输出时输入框不跟着重渲染）。
- `composerChoiceDismissal.ts`：Esc 的收起状态，按环境加轮次记，跨重挂载保留。
- `ComposerChoiceStrip.tsx`：快捷条。用 `Button size="xs" variant="outline"`，Tab/Esc 在文档上以捕获阶段监听，只处理焦点在本输入框编辑区且无修饰键、非输入法组字的按键。

## 上游文件改动（相对 `2f24a064c9`）

只有 `apps/web/src/components/chat/ChatComposer.tsx`：插入 23 行（含 2 行 import）、改行 2 行。

| 位置                                                    | 动作                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| import 区                                               | 插入 `ComposerChoiceStrip`、`useComposerChoices` 两行                                                                                    |
| `const offeredPromptSuggestion =`（约 `:2314`）         | 改名 `promptSuggestionSlot`，条件原样不动；`? promptSuggestion` 改成 `? { ghost: promptSuggestion }`                                     |
| 其后                                                    | 插入 `useComposerChoices` 调用、`showComposerChoices`，再按原名 `offeredPromptSuggestion` 取灰字或 null，占位文字与 Tab 提示因此一行不改 |
| 输入框正文 `data-chat-composer-body` 之前（约 `:3540`） | 插入 `<ComposerChoiceStrip>`                                                                                                             |

快捷条出现时灰字占位与 Tab 提示一并让位；上游的 Tab 填灰字、Esc 收灰字仍只管灰字。

## 同步上游时

- 上游改了 `offeredPromptSuggestion` 的条件：条件原样留在 `promptSuggestionSlot` 里，不必另抄。
- 手机宽度的收起态（`isComposerCollapsedMobile`）不显示快捷条，点开输入框后才出现。
- Esc 收起快捷条时不收灰字；灰字在没有快捷条时照旧。
