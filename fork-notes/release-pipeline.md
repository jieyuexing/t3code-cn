# 同步、构建与套装发布

fork 的同步上游、本地构建候选、目标验证和 Release 发布的现行做法。仓库 `jieyuexing/t3code-cn`，主分支 `main`；翻译层已冻结在 `i18n` 分支存档，`main` 不含翻译。

## 同步上游

合并上游 nightly 的流程是 **merge → focused tests → web 与 desktop 构建 → 更新说明**。冲突落在插件宿主挂载点上时按 [plugin-host.md](plugin-host.md)「同步上游时」处理。

打包用 `npm run dist:desktop:dmg:arm64:cn`，版本号自动取所基于的上游 nightly；构建时调用上游版本盖章脚本，结束后恢复包清单。推送并完成同源套装及目标验证后，按「套装发布」使用 `scripts/release-desktop-cn.mjs`。不含 Windows x64 运行包的套装或跨源码候选不能发布。

更新说明从 `git log --no-merges <旧基线>..<目标 tag>` 整理用户能感知的新功能、行为变化和重要修复，按桌面/网页、移动端（需另装商店版才有）、服务端与 Agent 分组，写进合并提交正文并在交付时告诉用户；纯 CI、依赖、测试类提交不列。

## 构建候选

`scripts/build-desktop-cn.mjs` 只构建三种目标：DMG arm64（`npm run dist:desktop:dmg:arm64:cn`，可显式指定 `--output-dir`，已有同名产物拒绝覆盖），以及 Linux x64、Windows x64 CLI archive。不构建 Windows NSIS 安装包。CLI 先 Linux 后 Windows 串行构建（`V` 为当前所基于的 upstream nightly，不带 `v`）：

```sh
node scripts/build-desktop-cn.mjs --platform linux --target archive --arch x64 \
  --official-archive /absolute/download/t3-V-linux-x64.tar.gz \
  --release-metadata /absolute/download/upstream-release.json \
  --sha256sums /absolute/download/SHA256SUMS --output-dir /absolute/output
# Windows 同命令改 --platform win，输入改为 t3-V-win32-x64.zip。
```

CLI 包装内部调用 `scripts/build-cli-cn.mjs`，在同一 nightly 盖章事务中重新构建 web/client 和 fork SEA，再立即调用 `build-cli-archive.ts` 保存该目标，避免下一目标清理 dist-exe。SEA 用同一已校验目标 Node 再封装，将内嵌 main 文件名改为相对路径，避免泄漏本机构建目录；上游 bootstrap 从 SEA 资产 `binMain.mjs` 加载 CLI 本体，再封装须按同一 pack 配置重出该资产并带上 `--require-module`，缺了 `--version` 即报 `ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND`。SEA 宿主必须等于根 `package.json` 的 `engines.node`（`build-cli-cn.mjs` 读取并比对，不一致即拒绝）。runner 上 DMG 与 publisher 作业不跟 `engines.node`，所用 Node 以 `jieyuexing/t3code-cn-build` 的 `.github/workflows/build.yml` 中 `dmg`、`publish` 作业的 `setup-node` 为准；`archives`、`windows-smoke` 作业按 `engines.node` 设置。设置任务独立 TMPDIR/TMP/TEMP 和构建子进程 home；不链接主树 node_modules 或 .env。

官方模板的校验与复用在 `scripts/cli-official-template-cn.ts`，上游 `build-cli-archive.ts` 只保留参数与调用点。官方模板必须来自精确同版 `pingdotgg/t3code` Release，元数据包含 asset size/digest/URL；同时校验 GitHub digest 和 SHA256SUMS（自身也校验 digest）。先检查本地 tag 是 HEAD 祖先、native/resource-monitor、lock、workspace 依赖配置、patches、外置依赖清单和 server manifest（仅忽略临时版本盖章）与 tag 完全一致，差异即拒绝。解包前检查全部路径与类型，拒绝链接、路径穿越、重复成员和特殊文件。只提取 node_modules 和 resource-monitor，Linux 另取 lib/（libatomic.so.1 与许可证，宿主没有 ldd/dpkg-query），再用 patchelf 给 fork t3 设 RUNPATH `$ORIGIN/lib`，因此 macOS 宿主需要 `brew install patchelf`；官方 t3/client 不进入候选。每个候选旁的 `.provenance.json` 记录来源 hash、复用成员逐文件 hash 和 fork 可执行文件 hash。node-pty 的其他 Windows 架构 vendor 文件与 ffi-rs ia32 sibling 原样保留，并按目录声明验架构；目标加载的二进制必须是 x64。

包装只接受列出的目标/参数，保持 feed-free、失败/信号后的清单恢复与并发修改拒绝。官方闭包复用不是原生依赖自主编译，也不替代目标系统运行验收。构建候选不修改既有 Release。

每件候选旁的 `.candidate.json` 包含版本、精确上游 commit、产物 bytes/hash、目标 OS/arch、包含未跟踪输入和维护脚本的完整源码指纹及 dirty 状态。版本盖章前后指纹必须相同；被忽略的 `.env` 输入拒绝。维护脚本、文档和测试变化也改变指纹；不同 dirty 产物即使 HEAD 相同也不能拼套装。候选可 dirty，发布必须 clean。

## 最终产物目标验证

以下入口只验证候选，不发布；路径均为本任务私有目录，TMPDIR/TMP/TEMP 指任务根：

```sh
# M3：只读挂载自己的 DMG，检查签名、版本、arm64、无更新 feed，卸载自己的挂载点。
node scripts/verify-release-candidate-cn.mjs --audit-dmg \
  --artifact /output/T3-Code-V-arm64.dmg --candidate /output/T3-Code-V-arm64.dmg.candidate.json \
  --output /task/dmg-audit
# 目标 OS/arch：最终 CLI archive 的关闭 monitor、清空环境、版本及有界 HTTP smoke。
node scripts/verify-release-candidate-cn.mjs --smoke-cli \
  --artifact /output/t3-V-linux-x64.tar.gz --candidate /output/t3-V-linux-x64.tar.gz.candidate.json \
  --output /isolated/task/cli-audit
```

CLI 的原上游 `smoke-cli-archive.ts` 保持原合同；发行目标入口额外绑定候选身份、禁用 monitor、保存原始退出/HTTP 回执，serve 启动配对信息不落日志。Windows CLI 改用 win32-x64 ZIP，在 Windows x64 执行；Node 及仓库依赖必须已备妥，不自动安装。以上均不是安装、GUI、provider 或生产切换验收。

取回私有回执后用同一验证入口 `--artifact ... --candidate ... --receipt /run/receipt.json` 重放。检查原件 hash、全部阶段、目标身份、退出/超时条件；不接受任意 `passed:true`。原始主机、IP、路径、PID、home 和回执不进入 Release。

## 套装发布

`scripts/release-desktop-cn.mjs` 是唯一 publisher。推送 `origin/main` 后，以同一 clean 源码构建要发布的产物并完成各自目标验证。publisher 只强制套装含 **Windows x64 archive**，DMG arm64、Linux x64 archive 对它可选。Release 只由公开仓库 `jieyuexing/t3code-cn-build` 的 `build.yml` 在 GitHub runner 上发布：每次构建 DMG arm64、Linux x64 与 Windows x64 archive 三件，各自在目标系统验证后调用本 publisher。下游跟随依赖这套三件：141 的 `t3-141-update win --release` 取 Windows x64 包，台式机的 `t3-desktop-update --release` 取 Linux x64 包，两者都先核对 SHA256SUMS 与 PROVENANCE.json。本机不上传 Release，runner 不可用时停下报告，不从本机补发；脚本里本机上传的代码路径（非 Actions 分支）已不再使用，去留由每日同步决定。`suite.json` 留任务目录，三件齐全时结构为（只发 Windows 时 artifacts 只留最后一项）：

```json
{
  "schema": 1,
  "version": "V",
  "artifacts": [
    {
      "artifact": "T3-Code-V-arm64.dmg",
      "candidate": "T3-Code-V-arm64.dmg.candidate.json",
      "receipt": "dmg-audit/receipt.json"
    },
    {
      "artifact": "t3-V-linux-x64.tar.gz",
      "candidate": "t3-V-linux-x64.tar.gz.candidate.json",
      "receipt": "linux-audit/receipt.json"
    },
    {
      "artifact": "t3-V-win32-x64.zip",
      "candidate": "t3-V-win32-x64.zip.candidate.json",
      "receipt": "windows-cli-audit/receipt.json"
    }
  ]
}
```

路径相对 suite 文件，也可为绝对私有路径。`V` 换为完整产品版本。先执行：

```sh
node scripts/release-desktop-cn.mjs --suite /task/suite.json --dry-run
# 已发布过同版时，必须由协调者明确选尚未使用的修订 tag；不会自动选择。
node scripts/release-desktop-cn.mjs --suite /task/suite.json --tag cn-vV-r1 --dry-run
```

dry-run 无 GitHub 写入。完整本地预检通过后才查远端：HEAD 必须精确等于当前 origin/main，tag 必须不存在或精确指向它，不能以任意远端包含 HEAD 代替。默认 tag 是 `cn-vV`，显式修订只接受 `cn-vV-rN`；产品版本和资产名不加 cn/rN。已有已发布 Release 永远不变。改名前已发布的 `zh-vV*` 不动；客户端读发布索引时两种前缀都认，但按版本号下载只拼 `cn-v`，所以只以 `zh-v` 发布过的版本不能再被新客户端按版本号取包。

获准正式发布时才去掉 `--dry-run`：先建立 draft、上传套装产物和自动生成的 SHA256SUMS/PROVENANCE.json，逐件核对 GitHub 存储 digest/size，完整才 publish。同源码、同套装 draft 可恢复；同名异 hash、额外资产、错误 tag 或另一套源码均拒绝，不删除或覆盖修复。本机路径（已不再使用）经既有 2080 代理，令牌由 `gh auth token` 取出，只经 stdin 配置交给 `/usr/bin/curl` 上传，不进入 argv/env/日志；GitHub Actions 上（`GITHUB_ACTIONS=true`）只接受工作流注入的 `GH_TOKEN`，直连并用 `gh release upload`。公开 provenance 只含必要版本、仓库/commit、源码与产物 hash、目标与检查边界，不上传私有候选清单或回执。Release 正文末尾的 `t3zh-source` 标记是改名前沿用的草稿恢复标识，保持原样。

定向验证：`vp test run scripts/build-desktop-cn.test.ts scripts/build-cli-archive.test.ts scripts/cli-official-template-cn.test.ts scripts/build-desktop-artifact.test.ts`、`node --test scripts/release-desktop-cn.test.mjs`。严格自包含测试需祖先无 node_modules 的合格隔离 TMP 根，不移动宿主目录来通过。归档来源检查仍可用 `--verify-template-only`；fixture 通过不能替代目标系统运行。
