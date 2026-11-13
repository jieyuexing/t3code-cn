# Warposs 定制思想传承

Warposs 是 Warp 终端开源版（`warp-oss`）的个人定制 fork（仓库 `warp-flash`，分支 `master`），2026-08-27 至 08-29 集中开发（另有一条 09-23 的文档修正），在上游 `d5d12d90f` 之上累计 45 个定制提交、约 293 个文件。它的定位是"终端是产品宿主、agent CLI 自己执行"：把 Codex、Grok 等官方 CLI 的会话接到终端侧栏里管理，并为阅读 agent 输出补一层 Markdown 阅读器，同时全量中文化。2026-10-06 起，产品"展示与交互"层的载体改为 T3 Code 的中文 fork（`t3code-cn`，2026-11-13 前叫 `t3code-zh`），Warposs 的角色被取代，仓库归档为只读：https://github.com/jieyuexing/warp-flash （分支 `master`）。本文不是功能清单，而是把每项定制背后的问题、取舍和落地边界记下来，供 t3code-zh 判断哪些值得接、哪些随终端载体一起失效。文中"事实"来自源仓规格与提交，"对 T3 的判断"逐条标注依据；未核对的写"待核对"。

## 1. 完整中文化（`warp_i18n` crate）

**要解决的问题。** 上游 Warp 没有本地化层，UI 文案散落在 Rust 源码里；个人日用需要简体中文界面，但终端输出、文件名、用户输入和模型回复绝不能被误翻。

**关键设计决定与取舍。** 新建独立 crate `warp_i18n`，只负责 locale 选择与翻译表，不依赖 WarpUI、应用状态、终端渲染和网络，默认 `zh-CN`，`WARP_LOCALE=en-US` 回到英文。核心取舍是把"借来的静态 UI 文案"和"自有字符串"分成两类入口：`localize_static` 只翻译静态借用文案、刻意放过 owned 字符串；`localize_ui` 用于按钮、菜单等调用方已明确是界面文本的边界；`localize_format!` 用具名占位符，译文可重排，运行时值原样代入。配套的 `script/i18n/audit_zh_cn.py --check` 把 GUI、onboarding、editor、WarpUI、TUI 根固定在 100% 覆盖，并拒绝未分类的格式化文案、占位符漂移和过期排除项；语言无关的字形和运行时数据模板在 `zh_cn_exclusions.json` 里逐条记原因，不计入翻译。放弃的是"在业务组件里逐条包翻译函数"的做法，改为边界分类加审计器。

**落地情况。** `845b29c`（主提交）、`a27d697`（文件树与 Git 菜单）、`3292ec5`（阅读器控件）及其他功能提交顺带补词条；文件在 `crates/warp_i18n/`、`crates/warp_i18n/locales/zh-CN.tsv`、`script/i18n/`。VALIDATION.md 记录审计通过 1170/1170。

**对 T3 的适用性。** t3code-cn 已经走了同一条路且更进一步（事实来源：fork `i18n/README.md`）：构建期字典转换、英文原文为 key、"保护规则优先于词典"、ignore 与位置覆盖账本、覆盖率 CLI。`warp_i18n` 的 owned/borrowed 分类思想在 T3 里对应"保护规则 + 显式显示 helper"，可视为已被 fork 自身覆盖。Rust 侧具体实现随载体失效。

## 2. 终端专用产品策略（terminal-only policy）

**要解决的问题。** 开源版若保留 Warp 自家 AI、账号登录、云端 Drive 等入口，用户会在设置、onboarding、菜单里反复撞到不可用的功能；而 Warposs 的意图恰恰是只做终端宿主，AI 由外部 CLI 提供。

**关键设计决定与取舍。** 把限制做成"发行渠道策略"而不是用户偏好：在 `Channel` 上加 `allows_ai()` 与 `allows_account_login()`，`Channel::Oss` 两者都返回 false，设置导航、隐私页、工作区视图、onboarding 意图与默认布局都查询这一个闸门。好处是每个 UI 和请求边界同时生效，不会漏一处；代价是 OSS 渠道完全放弃 Warp 原生 agent，这是有意为之。配套：OSS 启动直接进入标准工作区布局、跳过引导（`d43ac61`），macOS 关掉最后一个窗口时保留会话而不退出（`d94a79d`）。另有一个未链入应用的 spike `spikes/warp_embedded_surface`（`8dd356c`），定义了把终端表面嵌入原生宿主的 attach/detach 合同，只停在合同层。

**落地情况。** `8373e32`：`crates/warp_core/src/channel/mod.rs`、`app/src/settings_view/mod.rs`、`crates/onboarding/src/model.rs` 等 17 个文件。

**对 T3 的适用性。** 这一节整体随载体失效：T3 Code 本身就是"整合官方 CLI、不取代它们"的产品（事实来源：fork 根 `README.md` 开头的 "agent harness control surface" 与支持的 CLI 列表），没有需要剥离的自家 AI 层。可保留的只是方法论——产品级限制放在一个渠道/构建常量上，由所有边界查询，而不是散落的开关。embedded surface spike 没有后继，无需迁移。

## 3. CLI 中介：外部 agent 会话的发现、恢复与额度总览

**要解决的问题。** 上游 Warp 能探测第三方 CLI agent 并给它们工具条，但这些能力是"单会话局部"的：没有一个宿主级视图能列出本机所有 Codex/Grok 会话、重启终端后无法把某个 tab 接回原来的 agent 会话、两家额度要分别去各自 CLI 查。更深一层的需求是跨 agent 交接（Codex 做完的结论交给另一个 agent 继续），但那只写了合同。

**关键设计决定与取舍。** 规格的原则是"Warp 中介、agent 执行"：每个 CLI 保留自己的认证、沙箱、审批和内部记忆；宿主只索引、只准备、从不自动提交。三项硬约束被当作验收常量写进规格：`Universe 不进 Warp 运行时`（开发可由总仓驱动，产品不得在构建或运行时依赖总仓）、`CLI-first 固定流程`（register → validate → assemble → draft → review → place，不加守护进程和消息总线）、`viewUri=company://`（视图身份与浏览器内容 URL 分开）。技术选型明确拒绝"本地中介 daemon / MCP 控制服务"，选择在进程内投影现有会话模型，理由是不复制会话真相、可整体用 feature flag 摘除。

落地部分的两条关键取舍：

- 会话恢复目标必须"进程绑定"：Codex 恢复 ID 不是从 cwd 推断，而是把 PTY 前台进程组实际打开的 rollout 文件找出来、校验会话元数据与工作目录后才存入 tab 快照；找不到唯一身份就按普通终端恢复，不猜。理由是同一 checkout 可以合法地跑多个会话。恢复命令只接受安全字符集的 session ID，防止拼进 shell。
- 额度总览不合成：Codex 走本地 app-server 的 rate-limit 方法，Grok 走已登录 CLI 的计费端点，两家在标题栏放在同一视觉组但各自保留百分比、各自刷新、各自失败；禁止求和、平均、"最佳提供方"或自动切换，本地额度也不冒充 SSH 远端额度。

**落地情况。** 规格 `d40a378`（`specs/warposs-cli-mediation/{PRODUCT,TECH,STATUS}.md`、`docs/warposs/README.md`）。已实现的只有两个切片（STATUS.md 原话 `implemented`，桌面视觉验收 `unknown`）：外部会话浏览器 `app/src/external_session_index.rs` 与额度模型 `app/src/codex_rate_limits.rs`、`grok_rate_limits.rs`（`a0c760a`，flag `WarpossExternalSessionTabs` 默认关闭）；恢复目标持久化 `app/src/external_cli_resume.rs` 与 SQLite 迁移（`c826620`，后续 `c8d4430`、`16d558e`、`5456e53`、`3869731`、`1b7cc50` 修 Codex 重启恢复、Grok cwd 别名、重复恢复、PTY 进程绑定与 Grok 更新后恢复）；tab 标题与状态感知 CLI（`143e31e`、`b9239e5`，`app/src/terminal/title_generator.rs`、`session_status.rs`）；复制会话详情（`642cbcf`）。**未落地**：mediation registry、`warp.cli-handoff/v1` 交接信封、MCP assembly 预览、SSH 额度观测，均停在 `planned`/`deferred`。配套两件工程物：隔离的 Resume Lab 应用（`e0defb1`，`script/bundle-resume-lab`）和安全安装交接（`812a53a`，`script/install-warposs`、`script/macos/install_warposs_worker`）——替换应用时不向旧进程发 quit/kill，等待其自然退出，期间快照活动 agent 身份（pane UUID + provider session ID），退出后备份 `warp.sqlite` 并事务合并，身份冲突则中止。

**对 T3 的适用性。**

- 会话发现与恢复：T3 的线程由服务端持有，可归档、取消归档与删除（事实来源：fork `packages/contracts/src/orchestrationV2.ts` 的 `thread.archive`、`thread.unarchive`、`thread.delete` 命令），Codex 走 `packages/effect-codex-app-server` 的 `thread/resume` 协议（事实来源：该包 `replay.ts`、`schema.test.ts`）。Warposs 那套 PTY/rollout 文件绑定随终端载体失效；但"没有唯一身份就不猜、不按 cwd 推断"的原则值得在 T3 处理外部已有会话导入时保留。Grok 会话在 T3 的恢复方式待核对。
- 额度总览：T3 侧有 `universe quota`（事实来源：协调仓规则），是否有 UI 级两家并列的额度展示待核对。"独立观测、不合成、失败隔离"的展示规则值得迁移。
- 跨 agent 交接合同：T3 已有 `delegate_task`、`t3_thread_fork` 等线程级能力（事实来源：T3 MCP 工具列表），语义上覆盖了"把结论交给另一个 agent"的需求；Warposs 的信封格式与 `company://` 视图身份规则未在 T3 实现，是否需要待核对。
- 安装交接与 Resume Lab：针对 Rust 桌面包与 SQLite 的工程物，随载体失效；"升级不杀正在跑的 agent"这个要求本身对 T3 桌面端的 DMG 升级仍然成立，待核对 T3 现状。

## 4. agent 侧栏会话持久化与 mini 侧栏

**要解决的问题。** 右侧竖向 tab 面板是并行 agent 会话的控制面，但上游 tab 没有跨重启稳定的身份：归档、置顶、跨窗口移动都可能生成新身份，重启后 tab 和它对应的 agent 会话对不上。多会话并行时面板又太占宽度。

**关键设计决定与取舍。** 一个 tab 从创建到删除只有一个 UUID，归档是同一身份上的生命周期元数据（`active --archive--> archived --restore--> active`），删除是唯一结束持久化生命周期的操作；tab group 同样保留 UUID，重启后不重映射。SQLite 里存 `tabs.persistent_id / archived / archived_at`、`tab_groups.persistent_id`、`windows.vertical_tabs_panel_width / archived_tabs_expanded`；迁移时重命名旧的"仅归档"ID 列以保全既有 UUID，旧 tab 在加载时补发 ID。面板宽度与归档区展开状态也持久化，宽度低于阈值（112 px）即进入 mini 模式：只显示图标与状态点，隐藏分组标题和悬停工具条。放弃的是把归档做成独立列表或第二份身份。

**落地情况。** 归档与恢复 `696027d`（`app/src/workspace/view.rs`、`registry.rs`、`undo_close/stack.rs`、迁移 `add_archived_tabs`）；持久化 `d0e7b3f`；规格 `61288ef`、`3811c20`（`specs/warposs-session-sidebar-persistence/TECH.md`，含手工 fixture 路径）；mini 模式 `809845a`、`3c2272e`、`20648ba`、`a56b9ff`（均在 `app/src/workspace/view/vertical_tabs.rs`）。

**对 T3 的适用性。** 线程身份、归档与恢复在 T3 由服务端线程模型原生提供（事实来源：fork `packages/contracts/src/orchestrationV2.ts` 的 `thread.archive`、`thread.unarchive`、`thread.delete` 命令），可视为已覆盖。侧栏宽度、折叠/mini 显示是否持久化，在 `apps/web/src` 下未 grep 到明显对应项，待核对；若没有，"宽度阈值触发图标模式、分组标题与悬停工具条随之隐藏"是一个小而清晰的可迁移切片。

## 5. Markdown 阅读器与 Obsidian 风格阅读档案

**要解决的问题。** 两类场景：一是在终端里跑 Codex 等 CLI 时，输出的 Markdown 是渲染过的终端文本，长回复难读；二是工作区文件树里打开 `.md` 文件时的预览没有可读宽度和层级。更底层的问题（规格里的"推断"）是上游 Markdown 解析是行导向的 `nom` 自定义解析器，表格与正文走不同入口，引用块等结构会被压平。

**关键设计决定与取舍。** 规格把目标定为"以源码为权威的语义文档"，并给出了很长的 V2 合同（pulldown-cmark 适配器、带字节范围的 IR、流式稳定前缀、GUI/TUI 语义对等），但这些**没有开始实现**。实际落地的是一个"基础层"：`MarkdownReaderDocument` + `MarkdownReaderView` 把"权威源码"与"阅读投影"分开，声明 source/copy/selection 能力，文件 Markdown 和 CLI 输出共用同一个桌面阅读视图与同一套作用域样式。两个输入的来源被刻意区分：文件有 Reading/Source 两模式、Copy Source 返回精确字节；CLI tab 的输入是"保留在活动 block 里的完整终端网格的视觉快照"（含 scrollback、拼接软换行、沿用密文遮盖），明确标注 visual snapshot，不提供 Copy Source，不读取事件给出的 `transcript_path`，alternate screen 模式下不提供该动作（因为那只有当前视口）。Obsidian 只作为行为与视觉参照，不嵌入、不抄样式：可读行宽 700 px 居中、正文行高 1.6、代码 1.5、六级标题、细分隔线、带底色代码块、带边框条纹表格，这些是 Warposs 自己调出的数值。

**落地情况。** CLI 输出阅读器 `245c3ea`（`app/src/terminal/view/cli_agent_markdown_reader.rs`，同时落地 PRODUCT.md）；统一阅读面 `72bc599`（`app/src/notebooks/markdown_reader.rs`）；作用域样式 `0dceae1`（`crates/editor/src/render/model/`）；Obsidian 档案 `9d6c3ca`；可读宽度 `3ed3c2c`；表格列选择 `4cbabe0`；间距 `3965213`；fixture `fa22341`（`specs/warposs-markdown-rendering/fixtures/obsidian-reader-reference.md`）；验证记录 `3f79234`、`5fa9641`（VALIDATION.md，macOS 隔离 QA bundle 上十项目视检查通过，明确不声称 CLI 运行时走查、Windows/Linux 和 CommonMark 一致性）。

**对 T3 的适用性。** T3 Web 端已用 react-markdown + remark-gfm + rehype-sanitize/rehype-raw，并有 `markdown-incremental.ts`、`markdown-github-alerts.ts`、`markdown-links.ts`、`markdown-clipboard.ts`（事实来源：`apps/web/package.json`、`apps/web/src` 文件名）——这正是 Warposs V2 合同想做而未做的标准解析、GFM、增量渲染与 alert，可视为已覆盖。CLI 终端网格视觉快照这条路随载体失效：T3 通过 app-server/ACP 拿结构化回复（事实来源：`packages/effect-codex-app-server`、`packages/effect-acp` 存在），不需要从 PTY 反推。值得迁移的是阅读档案本身：可读行宽居中、行高、六级标题、代码与表格的可视规则，以及"视觉投影与权威源码分离、不把渲染文本冒充源码"的标注原则；T3 现有排版是否已等价，待核对。

## 6. 工作区标签页、Git 工具面板与文件树增强

**要解决的问题。** 这一组提交没有配套规格，动机只能从提交标题与改动范围反推（推断）：用终端做多仓并行开发时，需要在不离开工作区的情况下看 Git 状态并操作，并把 Git 工具与当前 tab 的项目关联；文件树需要正确展开符号链接目录并能用系统默认应用打开文件。

**关键设计决定与取舍。** Git 面板放在左侧面板作为一个工具视图，带独立 model、telemetry 与集成测试；通过 tab 关联让面板跟随当前工作区。symlink 展开在 `repo_metadata` 层识别链接目录并做"安全展开"（提交标题用词为 safely，具体保护规则材料未说明），并在远端 proto 里加链接标记以便图标显示。

**落地情况。** Git 面板 `8313e69`（`app/src/workspace/view/version_control/{model,view,telemetry}.rs`、`crates/integration/src/test/version_control.rs`）；与 tab 关联 `2825e54`；symlink 安全展开 `0876eec`（`crates/repo_metadata/src/entry.rs`）；链接目录图标 `c8eccd3`；系统默认应用打开 `dfc0f6e`（`app/src/code/file_tree/view.rs`）。

**对 T3 的适用性。** T3 有 diff 面板与文件操作（事实来源：`apps/web/src/diffPanelStore.ts`、`diffFileActions.ts`）以及 Git 操作菜单 Commit/Push（事实来源：fork `i18n/README.md`），Git 面板的核心需求可视为部分覆盖；暂存区级操作是否齐全待核对。symlink 目录展开与"用系统默认应用打开"在 T3 的现状待核对，若缺失属于小切片、值得迁移。

## 汇总表

| 定制思想                                 | 落地程度（Warposs）                 | 状态（对 T3）                            | 依据                                      |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------- | ----------------------------------------- |
| 中文化：owned/borrowed 边界分类 + 审计器 | 完整，100% 审计                     | 已被 T3 覆盖（由 fork 自身的字典层覆盖） | t3code-cn `i18n/README.md`                |
| terminal-only 渠道策略                   | 完整                                | 随载体失效（方法论可借鉴）               | fork `README.md`                          |
| embedded surface 生命周期 spike          | 仅合同，未链入                      | 随载体失效                               | 源仓 `spikes/`                            |
| 外部会话索引（Codex/Grok 分组）          | 实现，flag 默认关，视觉验收 unknown | 已被 T3 覆盖（服务端线程）               | `orchestrationV2.ts` 线程命令             |
| 进程绑定的恢复目标、不按 cwd 猜          | 实现                                | 随载体失效（原则值得迁移）               | `effect-codex-app-server` `thread/resume` |
| Grok 会话恢复                            | 实现                                | 待核对                                   | —                                         |
| 两家额度独立观测、不合成                 | 实现（模型与标题栏）                | 值得迁移（展示规则；UI 现状待核对）      | 协调仓规则仅见 `universe quota`           |
| 跨 agent 交接信封 / MCP 装配 / registry  | 仅合同                              | 已被 T3 覆盖（语义层；信封格式待核对）   | T3 MCP 工具列表                           |
| 安装交接不杀 agent、Resume Lab           | 实现（脚本）                        | 随载体失效（要求本身待核对）             | —                                         |
| tab 单一 UUID、归档/恢复同身份           | 实现                                | 已被 T3 覆盖                             | `orchestrationV2.ts` 线程命令             |
| 侧栏宽度持久化与 mini 图标模式           | 实现                                | 待核对（缺失则值得迁移）                 | `apps/web/src` 未见对应                   |
| Markdown V2（标准解析、IR、流式）        | 仅合同                              | 已被 T3 覆盖                             | `apps/web/package.json`、`markdown-*.ts`  |
| 共享阅读器：源码与投影分离、快照标注     | 实现                                | 值得迁移（作为原则）                     | —                                         |
| Obsidian 阅读档案（行宽、行高、层级）    | 实现并目视验证                      | 值得迁移（是否已等价待核对）             | —                                         |
| CLI 终端网格视觉快照阅读                 | 实现                                | 随载体失效                               | `effect-acp`、`effect-codex-app-server`   |
| Git 工具面板 + tab 关联                  | 实现                                | 已被 T3 覆盖（部分；暂存操作待核对）     | `diffPanelStore.ts`、i18n README          |
| symlink 安全展开、系统默认应用打开       | 实现                                | 待核对（缺失则值得迁移）                 | —                                         |
