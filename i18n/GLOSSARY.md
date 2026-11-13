# t3code-cn 翻译术语表与风格规范

翻译对象是 T3 Code（编码 Agent 图形界面）的界面文案。目标读者：中文开发者。

## 风格

- 简体中文，简洁、口语化但专业，参照 VS Code / JetBrains 中文界面的用词习惯。
- 按钮、菜单、标签：短语，不加句号；动宾结构（"New thread" → "新建线程"，"Copy path" → "复制路径"）。
- 完整句子（提示、说明、错误）：使用全角标点（，。：？！），句末保留原文对应的标点。
- 中文与英文单词、数字之间加一个半角空格（"打开 GitHub"、"3 个文件"）；与占位符 `{0}` 之间同样加空格，除非紧邻标点。
- 占位符 `{0}`、`{1}`… 必须原样保留；可以调整顺序。英文复数辅助片段（如 key 中 `comment{1}` 的 `{1}` 只用来拼 "s"）可以在译文中省略该占位符。
- 不翻译：产品与品牌名（T3 Code、T3 Connect、GitHub、GitLab、Bitbucket、Tailscale、Codex、Claude、Claude Code、Cursor、Grok、OpenCode、Antigravity、ChatGPT、OpenAI、Anthropic、Google、macOS、Windows、Linux、Electron、MCP、ACP、SSH、Git、npm、JSON 等）、模型名、命令、路径、环境变量、快捷键名（⌘、Ctrl、Shift、Enter、Esc 等）、文件扩展名、URL。
- 保留原文中的省略号 `…`、箭头 `→`、`·` 等符号；"Settings -> Source Control" 这类路径改写为中文菜单名并保持箭头。
- 原文是英文片段（被 JSX 元素截断的半句话，如 "Press" / "to send"）：按片段在中文中的自然位置翻译，必要时可以译为空字符串以外的最短连接词；不要补出原文没有的内容。
- 大小写不影响含义；全大写的标题按普通中文翻译。
- 不确定含义时根据位置（文件路径、上下文类别）推断；仍不确定就给出最直译、最中性的版本。

## 术语

| 英文                           | 中文                                 | 备注                                               |
| ------------------------------ | ------------------------------------ | -------------------------------------------------- |
| thread                         | 线程                                 | 与 Agent 的一段持久对话；"New thread" → 新建线程   |
| turn                           | 轮次                                 | 一次用户→Agent 的往返                              |
| project                        | 项目                                 |                                                    |
| environment                    | 环境                                 | 一个运行中的 T3 服务器及其机器                     |
| machine                        | 机器                                 |                                                    |
| client                         | 客户端                               |                                                    |
| workspace                      | 工作区                               |                                                    |
| worktree                       | 工作树                               | Git worktree                                       |
| checkout                       | 检出 / 工作副本                      | "Current checkout" → 当前检出                      |
| provider                       | 提供方                               | Codex、Claude 等 Agent 运行时                      |
| provider instance              | 提供方实例                           |                                                    |
| driver                         | 驱动                                 |                                                    |
| session                        | 会话                                 | 提供方运行时会话                                   |
| agent                          | Agent                                | 保留英文                                           |
| subagent                       | 子 Agent                             |                                                    |
| model                          | 模型                                 |                                                    |
| reasoning effort               | 推理强度                             | Low/Medium/High → 低/中/高                         |
| runtime mode / permission mode | 权限模式                             |                                                    |
| full access                    | 完全访问                             |                                                    |
| interaction mode               | 交互模式                             |                                                    |
| plan / plan mode               | 计划 / 计划模式                      |                                                    |
| approval                       | 审批                                 | approve → 批准，deny/reject → 拒绝                 |
| checkpoint                     | 检查点                               |                                                    |
| diff                           | 差异                                 | "View diff" → 查看差异                             |
| changes                        | 更改                                 |                                                    |
| restore / revert               | 恢复 / 还原                          |                                                    |
| pull request / PR              | 拉取请求 / PR                        | 短标签里用 PR                                      |
| review                         | 审查                                 | code review → 代码审查                             |
| branch                         | 分支                                 |                                                    |
| commit                         | 提交                                 | 名词与动词同                                       |
| push / pull / fetch            | 推送 / 拉取 / 获取                   |                                                    |
| merge / rebase                 | 合并 / 变基                          |                                                    |
| stash                          | 暂存                                 | 本应用中指暂存提示词                               |
| source control                 | 源代码管理                           |                                                    |
| repository                     | 仓库                                 |                                                    |
| composer                       | 输入框                               | 底部提示词编辑器                                   |
| prompt                         | 提示词                               |                                                    |
| message                        | 消息                                 |                                                    |
| attachment                     | 附件                                 |                                                    |
| context                        | 上下文                               |                                                    |
| terminal                       | 终端                                 |                                                    |
| command palette                | 命令面板                             |                                                    |
| keybinding / shortcut          | 快捷键                               |                                                    |
| settings                       | 设置                                 |                                                    |
| preferences                    | 偏好设置                             |                                                    |
| appearance                     | 外观                                 |                                                    |
| theme                          | 主题                                 |                                                    |
| snooze / unsnooze              | 稍后处理 / 取消稍后处理              |                                                    |
| settle / settled / un-settle   | 标记为已处理 / 已处理 / 恢复为待处理 | 侧边栏线程状态；auto-settle → 自动标记为已处理     |
| working / Working section      | 处理中 / 处理中分组                  | 侧边栏线程状态与分区；"Working for" 计时仍为已工作 |
| active（侧边栏分区）           | 收件箱                               | 与 inbox 同一分区；Sidebar.tsx 位置覆盖            |
| wake / woke                    | 唤醒 / 已唤醒                        |                                                    |
| snapshot / screenshot          | 快照 / 截图                          |                                                    |
| host                           | 托管平台（PR）/ 主机（SSH、本机）    |                                                    |
| stack                          | 堆叠                                 | PR 堆叠                                            |
| ref                            | ref                                  | 保留英文                                           |
| pin / unpin                    | 置顶 / 取消置顶                      |                                                    |
| archive / unarchive            | 归档 / 取消归档                      |                                                    |
| draft                          | 草稿                                 |                                                    |
| queue / queued                 | 队列 / 已排队                        |                                                    |
| stop / interrupt               | 停止 / 中断                          |                                                    |
| usage                          | 用量                                 |                                                    |
| rate limit                     | 速率限制                             |                                                    |
| relay                          | 中继                                 |                                                    |
| tunnel                         | 隧道                                 |                                                    |
| pair / pairing                 | 配对                                 |                                                    |
| connection(s)                  | 连接                                 |                                                    |
| remote                         | 远程                                 |                                                    |
| local                          | 本地                                 |                                                    |
| scheduled task                 | 定时任务                             |                                                    |
| skill                          | 技能                                 |                                                    |
| integration                    | 集成                                 |                                                    |
| account                        | 账号                                 |                                                    |
| sign in / sign out             | 登录 / 退出登录                      |                                                    |
| update                         | 更新                                 |                                                    |
| nightly                        | Nightly                              | 版本通道名保留                                     |
| diagnostics                    | 诊断                                 |                                                    |
| logs                           | 日志                                 |                                                    |
| browser                        | 浏览器                               |                                                    |
| preview                        | 预览                                 |                                                    |
| copy / copied                  | 复制 / 已复制                        |                                                    |
| open in …                      | 在 … 中打开                          |                                                    |
| retry                          | 重试                                 |                                                    |
| dismiss                        | 关闭                                 | 通知类                                             |
| cancel / confirm               | 取消 / 确认                          |                                                    |
| delete / remove                | 删除 / 移除                          |                                                    |
| rename                         | 重命名                               |                                                    |
| loading…                       | 正在加载…                            |                                                    |
| no … yet                       | 还没有…                              |                                                    |
