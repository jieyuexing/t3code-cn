import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readNeedsYouGtd, parseTopics } from "./NeedsYouGtd.ts";
import * as PluginHost from "./PluginHost.ts";
import { CHILD } from "./testChild.ts";

const DUE = {
  today: "2026-11-23",
  overdue: [
    {
      file: "host/docs/A.md",
      line: 3,
      date: "2026-11-20",
      daysLeft: -3,
      section: "旧事",
      excerpt: "过期了",
    },
  ],
  upcoming: [
    {
      file: "host/docs/B.md",
      line: 9,
      date: "2026-11-25",
      daysLeft: 2,
      section: "新事",
      excerpt: "快到了",
    },
  ],
};
const RECENT = {
  reposScanned: 39,
  privateCount: 9,
  linked: [{ file: "x" }, { file: "y" }, { file: "z" }],
  orphans: [
    { date: "2026-11-23", repo: "skills", file: "skills/a.md", subject: "feat: a", orphan: true },
  ],
};

const TOPICS = `# 话题收件

## 条目模板

\`\`\`yaml
- topic: 模板不算
  status: pending
\`\`\`

## 条目

\`\`\`yaml
- topic: 待办一
  thread: t3-thread://2756bac6-cb25-46d8-9777-39732a4d3973
  captured_at: 2026-11-11 18:30
  status: pending
- topic: 已开工
  thread: 纯文字来源
  captured_at: 2026-11-14 22:50
  status: started
- topic: 被丢掉
  thread: x
  status: dropped
- topic: 值里有 \`Plugin host: call-failed. failed: \` 这种裸冒号
  thread: z
  captured_at: 2026-11-16 09:00
  status: pending
  note: "带引号的 "备注" 不影响"
- topic: "带引号的话题"
  thread: 'q'
  captured_at: 2026-11-17 09:00
  status: started
- topic: 手写重复键
  thread: y
  captured_at: 2026-11-15 16:10
  status: started
  status: pending
\`\`\`

## 冻结箱（复盘日再议）

- 冻结的不算
  - 来源：t3-thread://214c215e-15c1-4de6-90b7-261f4b860aad
\`\`\`yaml
- topic: 冻结箱里的 yaml 也不算
  status: pending
\`\`\`
`;

const cliScript = (due: string, recent: string) => `#!/bin/sh
case "$1" in
  due)
${due}
  ;;
  recent)
${recent}
  ;;
esac
`;

const printJson = (value: unknown) => `cat <<'JSON'\n${JSON.stringify(value)}\nJSON`;

const makeUniverse = Effect.fn("makeUniverse")(function* (options: {
  readonly due?: string;
  readonly recent?: string;
  readonly topics?: string;
  readonly script?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-needs-you-gtd-" });
  yield* fs.makeDirectory(path.join(root, "host", "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "wiki", "gtd", "inbox"), { recursive: true });
  const bin = path.join(root, "host", "bin", "universe");
  yield* fs.writeFileString(
    bin,
    options.script ?? cliScript(options.due ?? printJson(DUE), options.recent ?? printJson(RECENT)),
  );
  yield* fs.chmod(bin, 0o755);
  yield* fs.writeFileString(
    path.join(root, "wiki", "gtd", "inbox", "topics.md"),
    options.topics ?? TOPICS,
  );
  return root;
});

describe("NeedsYouGtd", () => {
  it("keeps pending and started entries of the entries section only", () => {
    expect(parseTopics(TOPICS)).toEqual([
      {
        topic: "待办一",
        thread: "t3-thread://2756bac6-cb25-46d8-9777-39732a4d3973",
        capturedAt: "2026-11-11 18:30",
        status: "pending",
      },
      { topic: "已开工", thread: "纯文字来源", capturedAt: "2026-11-14 22:50", status: "started" },
      {
        topic: "值里有 `Plugin host: call-failed. failed: ` 这种裸冒号",
        thread: "z",
        capturedAt: "2026-11-16 09:00",
        status: "pending",
      },
      { topic: "带引号的话题", thread: "q", capturedAt: "2026-11-17 09:00", status: "started" },
      {
        topic: "手写重复键",
        thread: "y",
        capturedAt: "2026-11-15 16:10",
        status: "pending",
      },
    ]);
  });

  it.live("merges the CLI reports and the inbox of a universe repo", () =>
    Effect.gen(function* () {
      const cwd = yield* makeUniverse({});
      const digest = yield* readNeedsYouGtd({ cwd, dueDays: 7 });
      expect(digest).toMatchObject({
        available: true,
        overdue: DUE.overdue,
        upcoming: DUE.upcoming,
        orphans: [{ date: "2026-11-23", repo: "skills", file: "skills/a.md", subject: "feat: a" }],
        recentLinkedCount: 3,
        privateCount: 9,
        reposScanned: 39,
        errors: [],
      });
      expect(digest.orphans[0]).not.toHaveProperty("orphan");
      expect(digest.topics.map((topic) => topic.topic)).toEqual([
        "待办一",
        "已开工",
        "值里有 `Plugin host: call-failed. failed: ` 这种裸冒号",
        "带引号的话题",
        "手写重复键",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("passes the day windows to the CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeUniverse({
        script: `#!/bin/sh
echo "$*" > "$0.$1"
case "$1" in
  due) echo '{"overdue":[],"upcoming":[]}' ;;
  recent) echo '{"orphans":[],"linked":[],"privateCount":0,"reposScanned":0}' ;;
esac
`,
      });
      const argsOf = (command: string) =>
        fs.readFileString(path.join(cwd, "host", "bin", `universe.${command}`));
      yield* readNeedsYouGtd({ cwd, dueDays: 7, recentDays: 3 });
      expect([yield* argsOf("due"), yield* argsOf("recent")]).toEqual([
        "due --days 7 --json\n",
        "recent --days 3 --json\n",
      ]);
      yield* readNeedsYouGtd({ cwd });
      expect([yield* argsOf("due"), yield* argsOf("recent")]).toEqual([
        "due --days 30 --json\n",
        "recent --days 14 --json\n",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a project that is not the universe repo as unavailable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-needs-you-plain-" });
      const digest = yield* readNeedsYouGtd({ cwd });
      expect(digest).toEqual({
        available: false,
        overdue: [],
        upcoming: [],
        topics: [],
        orphans: [],
        recentLinkedCount: 0,
        privateCount: 0,
        reposScanned: 0,
        errors: [],
        scannedAt: digest.scannedAt,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a relative or missing cwd", () =>
    Effect.gen(function* () {
      const relative = yield* readNeedsYouGtd({ cwd: "wt" }).pipe(Effect.flip);
      const missing = yield* readNeedsYouGtd({ cwd: "/definitely/not/here" }).pipe(Effect.flip);
      expect([relative.reason, missing.reason]).toEqual(["invalid-input", "invalid-input"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("empties only the source that failed", () =>
    Effect.gen(function* () {
      const cwd = yield* makeUniverse({ due: "echo boom >&2; exit 3", recent: "echo not json" });
      const digest = yield* readNeedsYouGtd({ cwd });
      expect(digest.available).toBe(true);
      expect([digest.overdue, digest.upcoming, digest.orphans]).toEqual([[], [], []]);
      expect(digest.topics).toHaveLength(5);
      expect(digest.errors.map((error) => error.split(":")[0])).toEqual(["due", "recent"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the CLI reports when the inbox cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeUniverse({});
      const topicsPath = path.join(cwd, "wiki", "gtd", "inbox", "topics.md");
      yield* fs.remove(topicsPath);
      yield* fs.makeDirectory(topicsPath);
      const digest = yield* readNeedsYouGtd({ cwd });
      expect(digest.upcoming).toEqual(DUE.upcoming);
      expect(digest.topics).toEqual([]);
      expect(digest.errors).toHaveLength(1);
      expect(digest.errors[0]).toMatch(/^topics:/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("is served by PluginHost.call while the host switch is off", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeUniverse({});
      const stateDir = path.join(yield* fs.makeTempDirectoryScoped(), "state");
      const host = yield* PluginHost.make({
        stateDir,
        ...CHILD,
        attachmentsDir: path.join(stateDir, "attachments"),
        issueUrl: (attachmentId: string) =>
          Effect.succeed({ relativeUrl: `/api/assets/test/${attachmentId}`, expiresAt: 1 }),
        stopGrace: Duration.millis(500),
      });
      const refused = yield* host
        .call({ _tag: "callService", service: "a", method: "b", input: null })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("host-disabled");
      const result = yield* host.call({ _tag: "needsYouGtd", cwd });
      expect(result.value).toMatchObject({ available: true, recentLinkedCount: 3 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
