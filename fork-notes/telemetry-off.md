# 默认关闭产品使用数据上报

fork 构建默认不向官方 `ingest.t3.codes` 发产品使用事件（用户 11-19 选“默认关”）；设 `T3CODE_TELEMETRY_ENABLED=true` 才开启。README 的 “cn build” 段对外写明。

## 做法

- 默认值放在 fork 自有文件 `apps/server/src/telemetry/telemetryDefault.cn.ts`（`TELEMETRY_ENABLED_DEFAULT = false`），不在入口设环境变量：桌面端登录 shell 探测完成后会把 shell 里没有的 `T3CODE_TELEMETRY_ENABLED` 从进程环境删掉，入口写进去的 `false` 会被删回上游默认 `true`。
- 上游文件只改 `apps/server/src/telemetry/AnalyticsService.ts` 三处：加一行 import；`TelemetryEnvConfig.enabled` 的 `Config.withDefault(true)` 换成该常量；桌面端 shell 同意分支里重读偏好用的 `Config.withDefault(true)` 换成 `telemetryConfig.enabled`（探测删掉变量后沿用启动时已解析的开关，否则启动时显式开启会被回落成关）。
- 同步冲突时：取上游，再套这三处；上游若自己改了默认或加了开关，删这几处。
- 测试在自有文件 `apps/server/src/telemetry/AnalyticsService.cn.test.ts`：默认不发、显式 `true` 仍发、桌面探测删掉变量后显式开启仍发、探测后无变量仍不发。

## 盘点（默认会向官方发使用数据的路径）

- 服务端 `AnalyticsService`（PostHog 经 `ingest.t3.codes`）：本改动覆盖。
- 中继连接追踪（服务端 `apps/server/src/cloud/publicConfig.ts`、桌面 `apps/desktop/src/ipc/methods/window.ts`、网页 `apps/web/src/cloud/publicConfig.ts`）：只在构建时烘进 Axiom 令牌（`T3CODE_RELAY_CLIENT_OTLP_TRACES_*`、`VITE_RELAY_OTLP_TRACES_*`）才会发；fork 的构建仓 `build.yml` 不设这些，所以实际不发，没改。
- 手机端崩溃与用量上报（`apps/mobile`）：fork 不构建手机端，没改。
- 桌面端 `DesktopTelemetryPublisher` 等是本机主机采样，不出本机。
