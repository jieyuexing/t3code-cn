import { describe, expect, it, vi } from "vite-plus/test";

import { createHostApi, type HostApiDeps } from "./hostApi";

const CAPABILITY = "host.vcs-read";

function setup(
  capabilities: ReadonlyArray<string> = [CAPABILITY],
  workspaceRoot: string | null = "/work/repo",
) {
  const deps = {
    workspaceRoot,
    status: vi.fn(async (input: { cwd: string }) => ({ isRepo: true, cwd: input.cwd })),
    preview: vi.fn(),
    fileContents: vi.fn(async () => ({ oldContents: "old", newContents: "new" })),
    openDiff: vi.fn(),
    openPluginSettings: vi.fn(),
    pendingThreads: vi.fn(() => []),
    lastReply: vi.fn(async () => "reply"),
    question: vi.fn(async () => "Which table?"),
    openThread: vi.fn(),
    snoozeThread: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    openBrowser: vi.fn(async () => undefined),
    openFile: vi.fn(),
    addToComposer: vi.fn(),
    browserProfiles: vi.fn(() => [
      { id: "default", name: "Default", kind: "persistent" as const },
      { id: "incognito", name: "Incognito", kind: "incognito" as const },
    ]),
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

const THREADS_READ = "host.threads-read";
const THREADS_ORGANIZE = "host.threads-organize";
const OPEN_URL = "host.open-url";
const BROWSER = "host.browser";
const OPEN_FILE = "host.open-file";
const COMPOSER = "host.composer";

describe("host api", () => {
  it("keeps each thread method behind its own capability", async () => {
    const calls = [
      ["threads.pending", {}],
      ["threads.lastReply", { threadId: "t1" }],
      ["threads.question", { threadId: "t1" }],
      ["t3.openThread", { threadId: "t1" }],
      ["threads.snooze", { threadId: "t1", until: "2099-01-01T00:00:00Z" }],
    ] as const;
    for (const capabilities of [["views"], ["host.vcs-read"], ["settings"]]) {
      const { deps, call } = setup(capabilities);
      for (const [method, input] of calls) {
        await expect(call(method, input)).rejects.toMatchObject(DENIED);
      }
      expect(deps.lastReply).not.toHaveBeenCalled();
      expect(deps.question).not.toHaveBeenCalled();
      expect(deps.openThread).not.toHaveBeenCalled();
      expect(deps.snoozeThread).not.toHaveBeenCalled();
    }
    const reader = setup([THREADS_READ]);
    await expect(reader.call("threads.snooze", calls[4][1])).rejects.toMatchObject(DENIED);
    await expect(reader.call("threads.pending", {})).resolves.toEqual([]);
    await expect(reader.call("t3.openThread", { threadId: "t1" })).resolves.toBeNull();
    expect(reader.deps.openThread).toHaveBeenCalledWith("t1");
    const organizer = setup([THREADS_ORGANIZE]);
    await expect(organizer.call("threads.pending", {})).rejects.toMatchObject(DENIED);
  });

  it("returns the last reply clipped, and snoozes to a normalized time", async () => {
    const { deps, call } = setup([THREADS_READ, THREADS_ORGANIZE]);
    deps.lastReply.mockResolvedValue(`head${"x".repeat(60_000)}tail`);
    const reply = (await call("threads.lastReply", { threadId: "t1" })) as {
      text: string;
      truncated: boolean;
    };
    expect(reply.text).toHaveLength(60_000);
    expect(reply.text.endsWith("xxtail")).toBe(true);
    expect(reply.truncated).toBe(true);
    await expect(call("threads.question", { threadId: "t1" })).resolves.toEqual({
      threadId: "t1",
      question: "Which table?",
    });
    deps.question.mockResolvedValue("");
    await expect(call("threads.question", { threadId: "t1" })).resolves.toEqual({
      threadId: "t1",
      question: null,
    });
    await call("threads.snooze", { threadId: "t1", until: "2099-01-01T09:00:00+09:00" });
    expect(deps.snoozeThread).toHaveBeenCalledWith("t1", "2099-01-01T00:00:00.000Z");
    await expect(
      call("threads.snooze", { threadId: "t1", until: "tomorrow" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(call("threads.snooze", { until: "2099-01-01T00:00:00Z" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("opens only http(s) URLs, and only with host.open-url", async () => {
    const { deps, call } = setup([OPEN_URL]);
    await expect(call("t3.openUrl", { url: "https://example.com/a" })).resolves.toBeNull();
    expect(deps.openUrl).toHaveBeenCalledWith("https://example.com/a");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "/x"]) {
      await expect(call("t3.openUrl", { url })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(deps.openUrl).toHaveBeenCalledTimes(1);
    const denied = setup([CAPABILITY]);
    await expect(denied.call("t3.openUrl", { url: "https://example.com/" })).rejects.toMatchObject(
      DENIED,
    );
    expect(denied.deps.openUrl).not.toHaveBeenCalled();
  });

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
    // A bare path is a file too, the same as `t3.openDiff` takes it.
    await call("review.diffPreview", {
      cwd: "/repo",
      sourceKind: "working-tree",
      file: "src/a.ts",
    });
    expect(deps.preview).toHaveBeenLastCalledWith({
      cwd: "/repo",
      sourceKind: "working-tree",
      file: { path: "src/a.ts", previousPath: null, sourceKind: "working-tree" },
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

  it("opens the caller's own plugin settings only for a plugin that declared settings", async () => {
    const { deps, call } = setup(["views", "settings"]);
    await expect(call("t3.openPluginSettings", {})).resolves.toBeNull();
    // The target is whoever calls: input naming another plugin is not read.
    await expect(call("t3.openPluginSettings", { pluginId: "someone.else" })).resolves.toBeNull();
    expect(deps.openPluginSettings).toHaveBeenCalledTimes(2);
    expect(deps.openPluginSettings).toHaveBeenLastCalledWith();

    const withoutSettings = setup(["views", "host.vcs-read"]);
    await expect(withoutSettings.call("t3.openPluginSettings", {})).rejects.toMatchObject(DENIED);
    expect(withoutSettings.deps.openPluginSettings).not.toHaveBeenCalled();
  });

  it("keeps the Git methods behind host.vcs-read when a plugin declares only settings", async () => {
    const { deps, call } = setup(["settings"]);
    await expect(call("vcs.status", { cwd: "/repo" })).rejects.toMatchObject(DENIED);
    await expect(call("t3.openDiff", { kind: "working-tree" })).rejects.toMatchObject(DENIED);
    expect(deps.status).not.toHaveBeenCalled();
    expect(deps.openDiff).not.toHaveBeenCalled();
  });
  it("opens a page in the T3 browser only with host.browser", async () => {
    for (const capabilities of [["views"], [OPEN_URL], ["host.vcs-read"]]) {
      const { deps, call } = setup(capabilities);
      await expect(call("browser.open", { url: "https://example.com" })).rejects.toMatchObject(
        DENIED,
      );
      await expect(call("browser.profiles", {})).rejects.toMatchObject(DENIED);
      expect(deps.openBrowser).not.toHaveBeenCalled();
    }
    const { deps, call } = setup([BROWSER]);
    await expect(call("browser.open", { url: "https://example.com/a?b=1" })).resolves.toBeNull();
    expect(deps.openBrowser).toHaveBeenLastCalledWith({
      url: "https://example.com/a?b=1",
      background: false,
    });
    await expect(
      call("browser.open", {
        url: "http://127.0.0.1:3000/",
        profileId: "default",
        background: true,
      }),
    ).resolves.toBeNull();
    expect(deps.openBrowser).toHaveBeenLastCalledWith({
      url: "http://127.0.0.1:3000/",
      profileId: "default",
      background: true,
    });
    await expect(call("browser.profiles", {})).resolves.toEqual([
      { id: "default", name: "Default", kind: "persistent" },
      { id: "incognito", name: "Incognito", kind: "incognito" },
    ]);
  });

  it("rejects non-web URLs, unknown profiles and a non-boolean background", async () => {
    const { deps, call } = setup([BROWSER]);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "/x"]) {
      await expect(call("browser.open", { url })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      call("browser.open", { url: "https://example.com", profileId: "nope" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      call("browser.open", { url: "https://example.com", background: "yes" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });
  it("opens a workspace file in the T3 file panel only with host.open-file", async () => {
    for (const capabilities of [["views"], [OPEN_URL], [BROWSER], ["host.vcs-read"]]) {
      const { deps, call } = setup(capabilities);
      await expect(call("t3.openFile", { path: "src/a.ts" })).rejects.toMatchObject(DENIED);
      expect(deps.openFile).not.toHaveBeenCalled();
    }
    const { deps, call } = setup([OPEN_FILE]);
    await expect(call("t3.openFile", { path: "src/a.ts" })).resolves.toBeNull();
    expect(deps.openFile).toHaveBeenLastCalledWith("src/a.ts", undefined);
    await expect(
      call("t3.openFile", { path: "/work/repo/docs/b.md", line: 12 }),
    ).resolves.toBeNull();
    expect(deps.openFile).toHaveBeenLastCalledWith("docs/b.md", 12);
    await expect(call("t3.openFile", { path: "./src/../src/c.ts" })).resolves.toBeNull();
    expect(deps.openFile).toHaveBeenLastCalledWith("src/c.ts", undefined);
  });

  it("adds a quote to the thread's composer only with host.composer", async () => {
    for (const capabilities of [["views"], [OPEN_FILE], ["host.vcs-read"]]) {
      const { deps, call } = setup(capabilities);
      await expect(call("t3.addToComposer", { title: "T", text: "x" })).rejects.toMatchObject(
        DENIED,
      );
      expect(deps.addToComposer).not.toHaveBeenCalled();
    }
    const { deps, call } = setup([COMPOSER]);
    await expect(
      call("t3.addToComposer", {
        title: "Post",
        text: "chosen text",
        url: "https://example.com/p",
        source: "订阅 · Example",
      }),
    ).resolves.toBeNull();
    expect(deps.addToComposer).toHaveBeenLastCalledWith({
      title: "Post",
      text: "chosen text",
      url: "https://example.com/p",
      source: "订阅 · Example",
    });
    await expect(call("t3.addToComposer", { title: "Post", text: "x" })).resolves.toBeNull();
    expect(deps.addToComposer).toHaveBeenLastCalledWith({ title: "Post", text: "x" });
  });

  it("refuses an empty, oversized or non-web quote instead of clipping it", async () => {
    const { deps, call } = setup([COMPOSER]);
    for (const input of [
      { title: "", text: "x" },
      { title: "T", text: "  " },
      { title: "T", text: "x".repeat(32_001) },
      { title: "T".repeat(201), text: "x" },
      { title: "T", text: "x", url: "javascript:alert(1)" },
      { title: "T", text: "x", source: 3 },
    ]) {
      await expect(
        call("t3.addToComposer", input),
        JSON.stringify(input).slice(0, 40),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(deps.addToComposer).not.toHaveBeenCalled();
  });

  it("refuses files outside the thread's workspace, and bad lines", async () => {
    const { deps, call } = setup([OPEN_FILE]);
    for (const path of [
      "../secret.txt",
      "src/../../secret.txt",
      "/etc/passwd",
      "/work/repo-other/a.txt",
      "/work/repo",
      "",
    ]) {
      await expect(call("t3.openFile", { path }), path).rejects.toMatchObject({ code: "invalid" });
    }
    for (const line of [0, -1, 1.5, "3"]) {
      await expect(
        call("t3.openFile", { path: "a.txt", line }),
        String(line),
      ).rejects.toMatchObject({
        code: "invalid",
      });
    }
    expect(deps.openFile).not.toHaveBeenCalled();
    const noThread = setup([OPEN_FILE], null);
    await expect(noThread.call("t3.openFile", { path: "a.txt" })).rejects.toMatchObject({
      code: "call-failed",
    });
  });

  it("keeps the workspace boundary on Windows paths", async () => {
    const { deps, call } = setup([OPEN_FILE], "C:\\work\\repo");
    await expect(call("t3.openFile", { path: "C:\\work\\repo\\src\\a.ts" })).resolves.toBeNull();
    expect(deps.openFile).toHaveBeenLastCalledWith("src/a.ts", undefined);
    await expect(call("t3.openFile", { path: "src\\b.ts" })).resolves.toBeNull();
    expect(deps.openFile).toHaveBeenLastCalledWith("src/b.ts", undefined);
    await expect(call("t3.openFile", { path: "D:\\other\\a.ts" })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
