// check:changed 的 fork 包装：原样透传给上游 scripts/check-changed.ts，结束后追加一份上游文件侵入告警；
// 告警只打印，不影响退出码，退出码取 check-changed.ts 的。
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const run = (script, args) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, script), ...args],
    {
      stdio: "inherit",
    },
  );

const checked = run("check-changed.ts", process.argv.slice(2));
console.log("");
run("check-upstream-intrusion-cn.mjs", []);
process.exitCode = checked.status ?? 1;
