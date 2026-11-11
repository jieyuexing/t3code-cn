import { describe, expect, it, vi } from "vite-plus/test";

import { createHostApi, type HostApiDeps } from "./hostApi";

const CAPABILITY = "host.vcs-read";

function setup(capabilities: ReadonlyArray<string> = [CAPABILITY]) {
  const deps = {
    status: vi.fn(async (input: { cwd: string }) => ({ isRepo: true, cwd: input.cwd })),
    preview: vi.fn(),
    fileContents: vi.fn(async () => ({ oldContents: "old", newContents: "new" })),
    openDiff: vi.fn(),
  } satisfies Omit<HostApiDeps, "capabilities">;
  return { deps, call: createHostApi({ capabilities, ...deps }) };
}

const previewOf = (kind: "working-tree" | "commit", diff: string) => ({
  cwd: "/repo",
  generatedAt: "2026-11-11T00:00:00Z",
  sources: [
    {
      id: kind,
      kind,
      title: kind,
      baseRef: kind === "commit" ? "parentsha" : "HEAD",
      headRef: kind === "commit" ? "abc1234" : null,
      diff,
      diffHash: "h",
      truncated: false,
    },
  ],
});

const DENIED = { code: "denied" };

describe("host api", () => {
  it("denies every method to a plugin that did not declare host.vcs-read", async () => {
    const { deps, call } = setup(["views"]);
    for (const method of ["vcs.status", "review.diffPreview", "t3.openDiff"]) {
      await expect(call(method, { cwd: "/repo" })).rejects.toMatchObject(DENIED);
    }
    expect(deps.status).not.toHaveBeenCalled();
    expect(deps.openDiff).not.toHaveBeenCalled();
  });

  it("denies methods outside the allow-list, including write methods", async () => {
    const { call } = setup();
    for (const method of ["git.runStackedAction", "vcs.pull", "vcs.switchRef", "constructor", ""]) {
      await expect(call(method, { cwd: "/repo" })).rejects.toMatchObject(DENIED);
    }
  });

  it("passes only the cwd of vcs.status on, and refuses a missing cwd", async () => {
    const { deps, call } = setup();
    await expect(call("vcs.status", { cwd: "/repo", localOnly: false })).resolves.toEqual({
      isRepo: true,
      cwd: "/repo",
    });
    expect(deps.status).toHaveBeenCalledWith({ cwd: "/repo" });
    await expect(call("vcs.status", {})).rejects.toMatchObject({ code: "invalid" });
    await expect(call("vcs.status", null)).rejects.toMatchObject({ code: "invalid" });
  });

  it("asks for file lists only when no file is named, and for the one patch when it is", async () => {
    const { deps, call } = setup();
    deps.preview.mockResolvedValue(previewOf("working-tree", ""));
    await call("review.diffPreview", { cwd: "/repo", sourceKind: "working-tree" });
    expect(deps.preview).toHaveBeenLastCalledWith({
      cwd: "/repo",
      sourceKind: "working-tree",
      metadataOnly: true,
    });
    await call("review.diffPreview", {
      cwd: "/repo",
      sourceKind: "commit",
      commitSha: "abc1234",
      file: { path: "src/a.ts" },
    });
    expect(deps.preview).toHaveBeenLastCalledWith({
      cwd: "/repo",
      commitSha: "abc1234",
      file: { path: "src/a.ts", previousPath: null, sourceKind: "commit" },
    });
    await expect(
      call("review.diffPreview", { cwd: "/repo", sourceKind: "commit" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      call("review.diffPreview", { cwd: "/repo", sourceKind: "branch-range" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("reads both sides of a file with the change type and revisions its patch names", async () => {
    const { deps, call } = setup();
    deps.preview.mockResolvedValue(
      previewOf(
        "commit",
        "diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\n@@ -1 +1 @@\n",
      ),
    );
    await expect(
      call("review.diffFileContents", {
        cwd: "/repo",
        sourceKind: "commit",
        commitSha: "abc1234",
        file: { path: "new.ts", previousPath: "old.ts" },
      }),
    ).resolves.toEqual({ oldContents: "old", newContents: "new" });
    expect(deps.fileContents).toHaveBeenCalledWith({
      cwd: "/repo",
      sourceKind: "commit",
      changeType: "rename-changed",
      baseRef: "parentsha",
      headRef: "abc1234",
      oldPath: "old.ts",
      newPath: "new.ts",
    });

    deps.preview.mockResolvedValue(
      previewOf("working-tree", "diff --git a/n.ts b/n.ts\nnew file mode 100644\n"),
    );
    await call("review.diffFileContents", {
      cwd: "/repo",
      sourceKind: "working-tree",
      file: { path: "n.ts" },
    });
    expect(deps.fileContents).toHaveBeenLastCalledWith({
      cwd: "/repo",
      sourceKind: "working-tree",
      changeType: "new",
      baseRef: "HEAD",
      headRef: null,
      oldPath: "n.ts",
      newPath: "n.ts",
    });
  });

  it("opens T3's diff panel without returning anything, and wants a sha for a commit", async () => {
    const { deps, call } = setup();
    await expect(
      call("t3.openDiff", { kind: "commit", sha: "abc1234", file: "a.ts" }),
    ).resolves.toBeNull();
    expect(deps.openDiff).toHaveBeenCalledWith({ kind: "commit", sha: "abc1234", file: "a.ts" });
    await expect(call("t3.openDiff", { kind: "working-tree" })).resolves.toBeNull();
    expect(deps.openDiff).toHaveBeenLastCalledWith({ kind: "working-tree" });
    await expect(call("t3.openDiff", { kind: "commit" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(call("t3.openDiff", { kind: "turn" })).rejects.toMatchObject({ code: "invalid" });
  });
});
