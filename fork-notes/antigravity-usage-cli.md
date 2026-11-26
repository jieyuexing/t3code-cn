# Antigravity 额度窗口补回（官方 CLI `/usage`）

上游 5258（[#43026](https://github.com/pingdotgg/t3code/pull/43026)）删除了直调 Google 内部接口的 `antigravityUsageLimits.ts`。本 fork 通过独立 `.cn` 模块调用 T3 托管的官方 `antigravity` 二进制 `-p /usage --output-format json` 补回 `provider.usageLimits`，让 `Usage → Limits` 池化卡、Thread details 与 `modelpace` 恢复 `gemini` / `3p` 的 5 小时与周窗口，不恢复任何直调 Google 内部接口的代码，也不读取 token 文件内容。

## 口径

- **进程与隔离**：复用 `buildAntigravityAcpSpawnInput`（`antigravityAuthSupport.ts`）生成受控环境变量（保留代理配置、剥离冲突凭据变量、设置 `SSH_CONNECTION`、`AGY_ACP_FORCE_FILE_STORAGE=1`、`AGY_CLI_DISABLE_AUTO_UPDATE=true`、`BROWSER=""`），并覆盖 `HOME=<profileDirectory>/t3-usage-home`（Windows 同时覆盖 `USERPROFILE`）。参数为 `-p /usage --output-format json --print-timeout 25s --log-file <usage-home>/usage.log`（每次运行前截断该日志），工作目录与临时目录使用 `<runtimeTemp>` 下一次一删的子目录，经 `installation.acquire` 持有二进制租约，硬超时 30 秒并在实例 scope 关闭时强制清理子进程。
- **Token 软链**：`antigravity -p /usage` 顶层命令忽略 `--gemini-dir`，固定读取 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`。每次运行前确认 `<profileDirectory>/antigravity-acp/antigravity-oauth-token` 存在，并确保 `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token` 是指向它的软链（不存在或不是软链时重建）。Windows 若不支持创建软链，直接跳过并记日志，不复制 token。
- **跳过条件**：非 Google 登录（`oauth-personal` / `oauth-business` 以外）、实例禁用、安装缺失、快照 `auth.status === "unauthenticated"` 或 token 文件不存在时跳过；`auth.status === "unknown"`（重启后到首次开会话前）**不跳过**。
- **映射**：仅读取 `command.data.groups[].buckets[]`；原样保留 bucket `id`（`gemini-5h`、`gemini-weekly`、`3p-5h`、`3p-weekly` 等，未见 id 同样保留不丢）；`usedPercent = clamp((1 - remaining_fraction) * 100, 0, 100)` 保留浮点精度；`window` `"5h"` → `session` / 300 分钟、`"weekly"` → `weekly` / 10080 分钟、其余 → `other`；1970 或已过去的 `reset_time` 不填 `resetsAt`；`label` 固定使用 `"Gemini · 5-hour"` / `"Gemini · Weekly"` / `"Claude & GPT (shared) · 5-hour"` / `"Claude & GPT (shared) · Weekly"`（不含 `argon` / `carbon`）；只写 `modelScope`（`gemini` 组 `includePrefixes: ["gemini-"]`，`3p` 组 `["claude-", "gpt-"]`），不写 `modelIds` 和 `credentialFingerprint`；窗口顺序 Gemini 在前。
- **失败与调度**：退出码非 0、超时、JSON 解析失败、`status !== "SUCCESS"` 或无任何有效桶均视为失败（日志仅记 CLI 版本与错误首行，不打 token 或完整 stderr）。失败时保留上次成功读数与原 `checkedAt`，2 分钟后重试一次，随后回到 10 分钟周期；距上次成功超过 1 小时改为 `unavailable`（`reason: "probeFailed"`）。每实例单飞；等 `host.awaitServerReady` 与首检完成后首读，后台周期受 `host.shouldRunBackgroundWork` 约束。

## 挂载点与推送

- 全量逻辑位于 fork 自有模块 `apps/server/src/provider/antigravityUsageLimits.cn.ts`（测试见 `antigravityUsageLimits.cn.test.ts`）。
- 包装层自持一份额度状态 `Ref` 与对外合并变更流 `PubSub`，**不调用**底层 `applyUsageLimits`（避免被健康检查或元数据刷新清空）：
  - `getSnapshot`、`refresh`、`snapshotForCwd` 返回值直接叠加当前额度状态；
  - `streamChanges` 合并底层变更流与额度变更信号后叠加，底层 `isAwaitingFirstCheck` 为 `true` 时不因额度信号对外发射；
  - `refresh` 异步触发读取（距上次成功不足 60 秒用缓存）；`refreshUsage`（回合额度耗尽时调用）直接触发一次单飞读取；
  - 探针通过 `authFlow.withProcess` 运行，登录／登出可中断在途子进程并清空缓存，登录完成后重新读取。

## 上游文件改动

- 上游文件**仅改动** `apps/server/src/provider/Drivers/AntigravityDriver.ts`（1 行 import + 返回处包装调用，净增 4 行，触发 `check:changed` 上游侵入行阈值告警）；`AntigravityProvider.ts`、`packages/shared/src/usageLimits.ts`、`managedProvider.ts` 均未改动。
- 同步上游冲突时：取上游 `AntigravityDriver.ts`，在文件头重新 import `withAntigravityUsageLimits` 并在 `create` 返回值处包一层即可；若未来 Google 在官方 ACP 协议公开额度字段，可直接删除两个 `.cn.ts` 文件并撤回 `AntigravityDriver.ts` 包装。

## 已知局限

- 不改 `packages/shared/src/usageLimits.ts`：`exhaustedUsageWindow` 仅按 `modelIds` 过滤，因此当 `gemini` 组用满（100%）时，T3 内部会连带将该实例上的 Claude/GPT 也判为用满（不影响 `modelpace` 按 `modelScope` / `id` 各自估算）。
- 不读 token 文件内容、`/usage` 输出不含账号邮箱或指纹，因此不填 `credentialFingerprint`，跨机同号不会自动合并。
- 实测中 `/usage` 刷新 token 会原地覆盖，T3 ACP 会话换新文件刷新 token，极端并发同时写同一 token 文件的概率低，维持接受。
