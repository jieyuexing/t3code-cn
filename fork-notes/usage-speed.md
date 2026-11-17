# 用量页 Speed 分段

用量页顶部分段控件在 Cost、Tokens、Limits 之后多一段 Speed：按 模型 × 通道（provider）× 速度档（fast、ultrafast 单列）排行本机实测的输出速率，沿用页面的时段选择（最长 90 天）。上游文件只做插入，逻辑在 fork 自有文件。

## 口径

- 单次请求速率 = 输出 token（含思考）÷ 单次模型请求的墙钟耗时（含首字等待、网络与排队）。输出 <100 token、耗时不在 0.5–900 秒内的请求不计。
- 主指标是输出 ≥1000 token 请求的速率中位数；辅助是输出 ≤300 token 请求的耗时中位数、全部请求的速率中位数、各自样本数。长输出样本 <20 标「样本少」（斜纹条）；没有长输出样本的排在最后，条用全部请求速率画。
- 中位数不能跨来源合并，所以服务端每行（provider × model × 档 × sourcePath）下发三份稀疏对数直方图（相邻桶比 1.02，中位数误差 ≤1%）：`UsageSummary.requestSpeed`（`packages/contracts/src/usageSpeed.ts`）。客户端 `usageMerge` 按与 bucket 相同的来源归属过滤后再加直方图。可选字段，不升 `USAGE_CONTRACT_VERSION`；旧服务端没有该字段时页面显示“没有计时请求”，旧客户端忽略它（`usageSpeed.test.ts` 用去掉字段的旧 schema 解码验证）。
- 「派发成功」列：可选服务端设置 `usageDispatchScoresPath`（settings.json，默认空；空则整列不显示）指向总仓的派发评分 JSONL，只读解析（`apps/server/src/usage/dispatchScores.ts`），随 `UsageSummary.dispatchScores` 下发。成功公式 `accepted && !falseReport && !scopeViolation && stoppedOnDenial !== false && reworkRounds <= 1` 的 owner 是总仓 `host/packages/controller/docs/QUOTA-DISPATCH.md`，这里是照抄，那边改了要同步。按 provider/model 合并 effort 与 tier；评分里的 `claudeAgent` 记作 claude、`deepseek` 对应 OpenCode 通道；Antigravity 用量模型带的 `-high` 等 effort 后缀在匹配时去掉。统计的是全部历史，不随时段变。文件有无法解析的行时整份不显示（不给残缺计数）。多个环境各读一份时按模型取记录数最大的一份，不叠加。

## 各家耗时取法

| provider         | 起点 → 终点                                                                                                                               | 落点                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | 消息前最后一条 `type=user` 条目（提示或 tool_result；attachment 等不算）→ 同一 `message.id` 最后一块的时间戳                              | `claudeUsage.ts` 加了扫描状态 `lastUserMs`（Claude 读取器原先无状态）；`usageMarkers` 加 `"type":"user"`                                                                                                                                                                                 |
| Codex            | 上一条用户消息／`task_started`／`*_call_output` → 本次最后一个模型输出项（reasoning、function_call、custom_tool_call、assistant message） | `codexUsage.ts`：状态加 `requestStartMs`、`callStartMs`、`lastOutputMs`（`optionalKey`）；`token_usage_record` 与 `token_count` 出账时取走，每个带 info 的 `token_count`（含重复项）都清；补账的 `unreported` 不盖。`response_item`、`task_started` 行用前缀正则判断，不做整行 JSON 解析 |
| OpenCode         | `time.created` → `time.completed`                                                                                                         | `packages/provider-opencode/src/server/usage.ts`，输出 = output + reasoning                                                                                                                                                                                                              |
| Antigravity      | 规划步骤（step_type 15）元数据字段 1 → 字段 7                                                                                             | `antigravityUsageReader.ts`：只给单次 usage 的步骤盖（重试共用一个跨度，不盖）；合并时保留带跨度的那份                                                                                                                                                                                   |
| Grok             | 未接                                                                                                                                      | 读取器只读 `updates.jsonl`，时间戳是整秒，`turn_completed.usage` 没有 `modelCalls`，分不出单次调用的轮次；不用 `user_message_chunk → turn_completed` 近似                                                                                                                                |
| Cursor、Pi、Muse | 未接                                                                                                                                      | 没有单次请求起止                                                                                                                                                                                                                                                                         |

同一消息的多个副本合并（`mergeUsageCopies`、`dedupeWithinFile`）取首份的起点、最大的终点；Claude advisor 记录不盖耗时。

## 长期积累

扫描缓存升到 v18（`usage-scan-cache-v18.json`，v17 入旧文件清单）：Claude 与 Codex 的旧条目标 legacy，未变文件也会重解析一次以补上耗时。缓存按文件 mtime 只留 92 天（`CACHE_RETENTION_DAYS`），源日志被清理后已解析记录仍在，但最多留到那份日志最后写入后 92 天；v18 之前就只剩缓存的已删日志没有耗时。想真正长期积累，要么单独把 `requestSpeed` 按日落盘（新持久化），要么抬高留存天数（同时影响 Cost），本次没做。OpenCode、Antigravity 读的是各自数据库，保留期由它们决定。

## 上游文件改动

约 267 行插入、32 行改行（含 `CommandPalette.tsx` 一个词的改动被格式化成多行）：

| 文件                                                                                                                                    | 挂的是什么                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/provider-core/src/server/usage.ts`                                                                                            | `UsageRecord.request` 与 `UsageRequestSpan`                                           |
| `packages/contracts/src/{index,keybindings,settings,usage}.ts`                                                                          | 导出、`usage.speed` 命令、`usageDispatchScoresPath`、`requestSpeed`、`dispatchScores` |
| `packages/shared/{package.json,src/keybindings.ts,src/usageMerge.ts}`                                                                   | 子路径导出、默认键 `s`、按归属合并并排名                                              |
| `apps/server/src/usage/{usageAggregation,usageScanCache,UsageService}.ts`                                                               | `#accumulate` 里累加直方图、副本合并带起终点、缓存 v18、读派发评分                    |
| `apps/server/src/provider/Drivers/{claudeUsage,codexUsage,antigravityUsageReader}.ts`、`packages/provider-opencode/src/server/usage.ts` | 各家耗时（上表）                                                                      |
| `apps/web/src/components/usage/{UsagePage,usageShortcuts,usagePagePreferences}.tsx`、`CommandPalette.tsx`                               | Speed 分段、偏好枚举、命令面板搜索词                                                  |

fork 自有新文件：`contracts/src/usageSpeed.ts`、`shared/src/usageSpeed.ts`、`server/src/usage/{usageSpeedRows,dispatchScores}.ts`、`web/src/components/usage/{UsageSpeed.tsx,usageSpeedView.ts}` 及各自测试。

## 同步上游时

冲突按插入点重挂。`usageScanCache.ts` 的版本号与旧文件清单要接着上游往后排；Claude 的 `usageMarkers` 若上游改了，保留 `"type":"user"`。`mergeUsageCopies` 若上游加了新字段，保持 `request` 取首起点、最大终点。

## 未做

移动端没有 Speed 分段（`UsageRouteScreen.tsx` 的视图枚举与列表要单独做 RN 界面，本机无法验证）；`usageDispatchScoresPath` 只能改 settings.json，没有设置页入口；部分扫描（`partial`）里的增补 bucket 对应的速度行不合并。
