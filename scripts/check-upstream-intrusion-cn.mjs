// check:changed 的上游侵入检查入口：委托外部开源工具 fork-guard（配置见仓根 .fork-guard.json）。
// 用法：node scripts/check-upstream-intrusion-cn.mjs [--base <ref>] [--strict] [--staged] [--json]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

function findUniverseBin(startDir) {
  let current = NodePath.resolve(startDir);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = NodePath.join(current, "host", "bin", "universe");
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveForkGuardInvocation({
  cwd = REPO_ROOT,
  env = process.env,
  disableUniverseLookup = false,
  disablePathLookup = false,
} = {}) {
  const explicit = env.FORK_GUARD_BIN?.trim();
  if (explicit) {
    return /\.[cm]?js$/i.test(explicit)
      ? { command: process.execPath, prefixArgs: [explicit] }
      : { command: explicit, prefixArgs: [] };
  }

  for (const name of ["fork-guard", "fork-guard.cmd"]) {
    const localBin = NodePath.join(cwd, "node_modules", ".bin", name);
    if (NodeFS.existsSync(localBin)) {
      return { command: localBin, prefixArgs: [] };
    }
  }

  if (!disableUniverseLookup) {
    const universeBin = findUniverseBin(cwd);
    if (universeBin) {
      const lookup = NodeChildProcess.spawnSync(universeBin, ["path", "fork-guard"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const root = lookup.status === 0 ? lookup.stdout.trim() : "";
      if (root) {
        const entry = NodePath.join(root, "bin", "fork-guard.mjs");
        if (NodeFS.existsSync(entry)) {
          return { command: process.execPath, prefixArgs: [entry] };
        }
      }
    }
  }

  if (!disablePathLookup) {
    const probe = NodeChildProcess.spawnSync("fork-guard", ["--version"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (probe.status === 0) {
      return { command: "fork-guard", prefixArgs: [] };
    }
  }

  return null;
}

export function main(argv, options = {}) {
  const cwd = options.cwd ?? REPO_ROOT;
  const invocation = resolveForkGuardInvocation({ ...options, cwd });
  if (!invocation) {
    console.log(
      "fork-guard check: skipped (fork-guard CLI not found; install fork-guard or set FORK_GUARD_BIN)",
    );
    return 0;
  }

  const result = NodeChildProcess.spawnSync(
    invocation.command,
    [...invocation.prefixArgs, "check", "--cwd", cwd, ...argv],
    { stdio: options.stdio ?? "inherit" },
  );
  return result.status ?? 1;
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
