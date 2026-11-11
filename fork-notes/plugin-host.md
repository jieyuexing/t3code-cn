# 插件宿主

t3code-zh 自建的通用插件系统，语义参照 Cordis：插件按清单声明它提供和注入的服务，宿主负责依赖齐了才启动、注册可撤销、提供方下线时依赖方自动停下、回来后自动恢复。同一份服务声明同时生成四种入口：别的插件注入、面板视图调用、Agent 工具、命令面板与服务面板。用户决定与取舍记录在总仓 `host/docs/PRODUCT-DIRECTION.md`「2026-11-10：围绕 T3 Code 做插件机制」，本文只写现行结构和同步时怎么维护。

## 现行形态

- **清单**：插件目录根上的 `plugin.json`，按 Agent Plugins 1.0；T3 专有字段放在 `extensions["com.jieyuexing.t3code"]`，包括 `entry`、`capabilities`、`inject`、`provides`、`views`、`title`。格式以 `packages/contracts/src/pluginHost/manifest.ts` 为准，写法看 `plugin-host-examples/` 下的两个示例。
- **运行**：每个插件跑在一个受监督的子进程里，插件用到才启动。这是受信的本机代码，不是沙箱。子进程入口是 `apps/server/src/pluginHost/childRuntime.ts`。
- **服务**：服务名全局唯一。提供方停用、隔离或重载时，依赖它的插件进入 `waiting`。方法标 `"agent": true` 的进 Agent 工具 `plugin_services`／`plugin_call`；标 `"ui": true` 的进命令面板和服务面板。
- **视图**：整页 HTML，放在沙箱 iframe 里，经 MessagePort 桥调用插件处理器，或调用插件注入的服务。
- **开关**：设置页「插件」按环境管理，环境级总开关默认关。
- **Cordis 写法**：可选的适配包在 `plugin-host-cordis/`，不进 pnpm workspace，自带 npm 锁文件，`cordis` 版本固定在这里，宿主代码不依赖它。

## 自有目录

| 目录                                               | 内容                                               |
| -------------------------------------------------- | -------------------------------------------------- |
| `packages/contracts/src/pluginHost/`               | 清单、RPC 载荷与快照 schema                        |
| `apps/server/src/pluginHost/`                      | 加载、对账、子进程、服务转发、Agent 工具、视图交付 |
| `apps/web/src/pluginHost/`                         | 视图框与桥、命令面板项、服务面板、设置页           |
| `packages/client-runtime/src/state/pluginHost*.ts` | 网页端按环境的快照状态                             |
| `plugin-host-examples/`                            | 示例 `echo-clock`、`greeter`                       |
| `plugin-host-cordis/`                              | 可选的 Cordis 适配包与示例 `example.counter`       |

## 上游挂载点

规则：上游文件只做插入，合计不超过 80 行。目前用了 67 行插入、3 行改动，另有预算快照的 1 行数字和生成的路由表。

| 文件                                                           | 插入              | 挂的是什么                                |
| -------------------------------------------------------------- | ----------------- | ----------------------------------------- |
| `packages/contracts/src/rpc.ts`                                | 3                 | `pluginHost` 的 WS 方法、RPC 定义、RPC 组 |
| `packages/contracts/src/clientRpcPermissions.ts`               | 1                 | 受保护方法登记                            |
| `packages/contracts/src/index.ts`                              | 1                 | 导出 `pluginHost`                         |
| `packages/client-runtime/package.json`                         | 4                 | `pluginHost` 状态的导出                   |
| `packages/client-runtime/src/rpc/client.ts`                    | 1                 | 客户端 RPC 方法                           |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | 1                 | 权限表测试                                |
| `apps/server/src/ws.ts`                                        | 4                 | RPC 处理器                                |
| `apps/server/src/ws.test.ts`                                   | 2                 | 测试替身                                  |
| `apps/server/src/server.ts`                                    | 2                 | 运行时层组装                              |
| `apps/server/src/binMain.ts`                                   | 3                 | 隐藏命令 `__plugin-host`（子进程入口）    |
| `apps/server/src/auth/RpcAuthorization.ts`                     | 3                 | 方法鉴权                                  |
| `apps/server/src/observability/RpcInstrumentation.ts`          | 2                 | 观测表                                    |
| `apps/server/src/mcp/McpHttpServer.ts`                         | 2                 | Agent 工具集                              |
| `apps/server/src/provider/AgentContextBudget.test.ts`          | 2                 | 预算测试                                  |
| `apps/server/src/provider/agentContextBudget.json`             | 改 1              | 工具描述字节数，按实测写                  |
| `apps/web/src/rightPanelStore.ts`                              | 11（含 2 处改行） | 面板种类 `plugin` 与打开动作              |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx`    | 3                 | 面板内容分支                              |
| `apps/web/src/components/RightPanelTabs.tsx`                   | 5                 | 标签标题与图标                            |
| `apps/web/src/closedViewStore.ts`                              | 2                 | 关闭后可重开                              |
| `apps/web/src/reopenClosedView.ts`                             | 3                 | 关闭后可重开                              |
| `apps/web/src/components/CommandPalette.tsx`                   | 4（含 1 处改行）  | 命令面板「插件」组                        |
| `apps/web/src/appInit.tsx`                                     | 2                 | 启动时订阅快照                            |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`      | 2                 | 设置页导航项                              |
| `apps/web/src/components/settings/settingsSearch.ts`           | 4                 | 设置搜索                                  |
| `apps/web/src/routes/_chat.settings.plugins.tsx`               | 新文件 5          | 设置页路由                                |
| `apps/web/src/routeTree.gen.ts`                                | 生成              | 路由表                                    |

## 同步上游时

1. 冲突落在上表的文件里时，先取上游版本，再按上表把插件那几行插回去，不手工合并上游的改动。`rightPanelStore.ts` 最容易冲突。
2. `routeTree.gen.ts` 不要手合，重新生成。
3. `agentContextBudget.json` 先取上游的三个数，再跑 `apps/server` 的 `vp test run src/provider/AgentContextBudget.test.ts`，把 `mcpToolListJsonBytes` 改成实测值（插件工具比上游多约 479 字节）。
4. 合并后用 `rg -l pluginHost apps packages` 对照上表，缺一处就补一处。然后在 `apps/server` 跑 `vp test run src/pluginHost src/ws.test.ts src/auth/RpcAuthorization.test.ts src/mcp`，在 `apps/web` 跑 `vp test run src/pluginHost`。
5. 插入行数要超过 80 行时，先停下来，写明原因再议，不悄悄放宽。

## 未验证

Electron 桌面端、Windows（141）上的子进程通信、官方手机版（看不到插件）、Agent 工具的 evals（没有 API key）、真实界面里的 “Modifies” 标记。
