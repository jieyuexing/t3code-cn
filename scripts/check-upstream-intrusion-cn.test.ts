// @effect-diagnostics nodeBuiltinImport:off -- Loads the plain .mjs wrapper and runs real temp git repos.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface Invocation {
  readonly command: string;
  readonly prefixArgs: ReadonlyArray<string>;
}

interface IntrusionWrapperModule {
  readonly resolveForkGuardInvocation: (options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    disableUniverseLookup?: boolean;
    disablePathLookup?: boolean;
  }) => Invocation | null;
  readonly main: (
    argv: ReadonlyArray<string>,
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      disableUniverseLookup?: boolean;
      disablePathLookup?: boolean;
      stdio?: "inherit" | "pipe";
    },
  ) => number;
}

const scriptUrl = NodeURL.pathToFileURL(
  NodePath.join(import.meta.dirname, "check-upstream-intrusion-cn.mjs"),
).href;
const { resolveForkGuardInvocation, main }: IntrusionWrapperModule = await import(scriptUrl);

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const tempDirs: Array<string> = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: ReadonlyArray<string>) {
  const res = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

describe("check-upstream-intrusion-cn fork-guard wrapper", () => {
  it("ships a valid .fork-guard.json with upstream nightly tag and collapse rule", () => {
    const raw = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoRoot, ".fork-guard.json"), "utf8"),
    ) as {
      upstream?: { tagPattern?: string; ref?: string };
      maxLinesPerUpstreamFile?: number;
      hotFiles?: Array<string>;
      collapse?: Array<{ name: string; glob: string }>;
    };
    expect(raw.upstream?.tagPattern).toBe("v*-nightly.*");
    expect(raw.maxLinesPerUpstreamFile).toBe(15);
    expect(raw.hotFiles).toContain("apps/server/src/ws.ts");
    expect(raw.collapse?.some((c) => c.name === "i18n")).toBe(true);
  });

  it("prefers FORK_GUARD_BIN when explicitly provided and skips cleanly when unavailable", () => {
    const viaEnv = resolveForkGuardInvocation({
      cwd: repoRoot,
      env: { FORK_GUARD_BIN: "/custom/fork-guard.mjs" },
    });
    expect(viaEnv).toEqual({
      command: process.execPath,
      prefixArgs: ["/custom/fork-guard.mjs"],
    });

    const missing = resolveForkGuardInvocation({
      cwd: NodeOS.tmpdir(),
      env: {},
      disableUniverseLookup: true,
      disablePathLookup: true,
    });
    expect(missing).toBeNull();
    expect(
      main([], {
        cwd: NodeOS.tmpdir(),
        env: {},
        disableUniverseLookup: true,
        disablePathLookup: true,
      }),
    ).toBe(0);
  });

  it("delegates to fork-guard check and enforces HOT vs SHRINK semantics", () => {
    const invocation = resolveForkGuardInvocation({ cwd: repoRoot });
    expect(invocation).not.toBeNull();

    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fg-"));
    tempDirs.push(dir);

    git(dir, ["init", "-b", "upstream-main"]);
    NodeFS.mkdirSync(NodePath.join(dir, "src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "src/hot.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "upstream"]);

    git(dir, ["checkout", "-b", "main"]);
    NodeFS.writeFileSync(
      NodePath.join(dir, ".fork-guard.json"),
      JSON.stringify({
        upstream: { ref: "upstream-main" },
        hotFiles: ["src/hot.ts"],
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "src/hot.ts"),
      "export const a = 1;\nexport const f1 = 1;\nexport const f2 = 2;\n",
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "fork baseline"]);
    git(dir, ["branch", "base-main"]);

    const bin = invocation!.prefixArgs[0] ?? invocation!.command;
    const env = { ...process.env, FORK_GUARD_BIN: bin };

    // Shrinking a hot file passes --strict
    NodeFS.writeFileSync(
      NodePath.join(dir, "src/hot.ts"),
      "export const a = 1;\nexport const f1 = 1;\n",
    );
    expect(main(["--base", "base-main", "--strict"], { cwd: dir, env, stdio: "pipe" })).toBe(0);

    // Expanding a hot file fails --strict
    NodeFS.writeFileSync(
      NodePath.join(dir, "src/hot.ts"),
      "export const a = 1;\nexport const f1 = 1;\nexport const f2 = 2;\nexport const f3 = 3;\n",
    );
    expect(main(["--base", "base-main", "--strict"], { cwd: dir, env, stdio: "pipe" })).toBe(1);
  });
});
