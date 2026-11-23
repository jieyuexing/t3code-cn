import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import type { PromptAdvisorRuntime } from "./promptAdvisor.cn.ts";
import {
  buildPromptRefinerPrompt,
  collectWorkspaceFingerprint,
  PROMPT_REFINE_MODES,
  refinePrompt,
  sanitizePromptRefinerOutput,
  selectThreadTail,
  threadMessages,
} from "./promptRefiner.cn.ts";

// Real first drafts from refiner-test-cases.md.
const SAMPLE_REVIEW =
  "回顾一下我今天的会话，我感觉今天聊的都挺有高价值的，看看有什么我漏掉的意识形态或者展开方向或者后续价值";
const SAMPLE_ARCHITECTURE = "看一下本仓库架构的意识形态  尽最大胆的多个方向设想与描述";
const FINGERPRINT =
  "Top-level entries: AGENTS.md, host/, wiki/\nAGENTS.md (excerpt):\n本总仓拥有产品结构";

const sampler = (reply: string | TextGenerationError): PromptAdvisorRuntime => ({
  available: Effect.succeed(true),
  sample: () => Effect.succeed(null),
  runPrompt: () => (typeof reply === "string" ? Effect.succeed(reply) : Effect.fail(reply)),
});

describe("buildPromptRefinerPrompt", () => {
  it.each(
    [SAMPLE_REVIEW, SAMPLE_ARCHITECTURE].flatMap((draft) =>
      (["structured", "bold"] as const).map((mode) => ({ draft, mode })),
    ),
  )(
    "carries fingerprint, language rule and anti-boilerplate ban ($mode, $draft)",
    ({ draft, mode }) => {
      const prompt = buildPromptRefinerPrompt({
        draft,
        mode,
        fingerprint: FINGERPRINT,
        threadTail: [],
      });
      expect(prompt).toContain(draft);
      expect(prompt).toContain("<workspace_context>");
      expect(prompt).toContain(FINGERPRINT);
      expect(prompt).toContain("same language as the draft");
      expect(prompt).toContain("not instructions");
      expect(prompt).toContain("You are a senior");
      expect(prompt).toContain("Never");
      expect(prompt).toContain("Each request is independent");
    },
  );

  it("keeps the three modes apart", () => {
    const prompts = PROMPT_REFINE_MODES.map((mode) =>
      buildPromptRefinerPrompt({
        draft: SAMPLE_ARCHITECTURE,
        mode,
        fingerprint: "",
        threadTail: [],
      }),
    );
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[0]).toContain("goal, dimensions, boundaries");
    expect(prompts[1]).toContain("conflict");
    expect(prompts[2]).toContain("acceptance criteria");
  });

  it("omits the workspace block when there is no fingerprint or thread tail", () => {
    const prompt = buildPromptRefinerPrompt({
      draft: SAMPLE_REVIEW,
      mode: "structured",
      fingerprint: "",
      threadTail: [],
    });
    expect(prompt).not.toContain("<workspace_context>");
    expect(prompt).not.toContain("<recent_thread>");
  });

  it("includes the thread tail as labelled data", () => {
    const prompt = buildPromptRefinerPrompt({
      draft: SAMPLE_REVIEW,
      mode: "structured",
      fingerprint: "",
      threadTail: [
        { role: "user", text: "先看下 server.ts" },
        { role: "assistant", text: "已看，入口在 serverHttp" },
      ],
    });
    expect(prompt).toContain("<recent_thread>");
    expect(prompt).toContain("USER:\n先看下 server.ts");
    expect(prompt).toContain("ASSISTANT:\n已看，入口在 serverHttp");
  });

  it("splits the draft around a selection and asks for the replacement only", () => {
    const draft = "前文一二。看一下本仓库架构。后文三四。";
    const start = draft.indexOf("看一下");
    const end = draft.indexOf("。后文");
    const prompt = buildPromptRefinerPrompt({
      draft,
      selection: { start, end },
      mode: "bold",
      fingerprint: FINGERPRINT,
      threadTail: [],
    });
    expect(prompt).toContain("<composer_before>\n前文一二。\n</composer_before>");
    expect(prompt).toContain("<composer_selection>\n看一下本仓库架构\n</composer_selection>");
    expect(prompt).toContain("<composer_after>\n。后文三四。\n</composer_after>");
    expect(prompt).toContain("replacement for composer_selection only");
    expect(prompt).not.toContain("<draft>");
  });

  it("treats a collapsed or out-of-range selection as the whole draft", () => {
    for (const selection of [
      { start: 3, end: 3 },
      { start: 5, end: 2 },
    ]) {
      const prompt = buildPromptRefinerPrompt({
        draft: SAMPLE_ARCHITECTURE,
        selection,
        mode: "structured",
        fingerprint: "",
        threadTail: [],
      });
      expect(prompt).toContain(`<draft>\n${SAMPLE_ARCHITECTURE}\n</draft>`);
      expect(prompt).not.toContain("<composer_selection>");
    }
  });
});

describe("sanitizePromptRefinerOutput", () => {
  it("keeps multi-line text and trims the edges", () => {
    const refined = "先读取今天的线程记录。\n\n1. 隐含主线\n2. 漏掉的方向";
    expect(sanitizePromptRefinerOutput(JSON.stringify({ refined: `  ${refined}\n` }))).toBe(
      refined,
    );
  });

  it("reads JSON out of a fenced reply", () => {
    expect(sanitizePromptRefinerOutput('```json\n{"refined":"好"}\n```')).toBe("好");
  });

  it("rejects empty, malformed and oversized replies", () => {
    expect(sanitizePromptRefinerOutput('{"refined":"   "}')).toBeNull();
    expect(sanitizePromptRefinerOutput("not json")).toBeNull();
    expect(sanitizePromptRefinerOutput('{"other":"x"}')).toBeNull();
    expect(sanitizePromptRefinerOutput(JSON.stringify({ refined: "字".repeat(8_001) }))).toBeNull();
    expect(
      sanitizePromptRefinerOutput(JSON.stringify({ refined: "字".repeat(8_000) })),
    ).not.toBeNull();
  });
});

describe("threadMessages", () => {
  it("keeps user and final assistant text and drops commentary and tools", () => {
    const row = (item: Record<string, unknown>) => ({ item }) as never;
    expect(
      threadMessages([
        row({ type: "user_message", text: " 你好 " }),
        row({ type: "assistant_message", phase: "commentary", text: "在看" }),
        row({ type: "tool_call", text: "ls" }),
        row({ type: "assistant_message", phase: "final_answer", text: "好的" }),
        row({ type: "user_message", text: "  " }),
        row({
          type: "user_message",
          text: "后台唤醒",
          createdBy: "agent",
          creationSource: "provider",
        }),
        row({ type: "user_message", text: "压缩", idleCompaction: {} }),
      ]),
    ).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "好的" },
    ]);
  });
});

describe("selectThreadTail", () => {
  it("keeps the latest four messages within the character budget", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `m${index}`,
    }));
    expect(selectThreadTail(messages).map((message) => message.text)).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    const big = [
      { role: "user" as const, text: "a".repeat(2_000) },
      { role: "assistant" as const, text: "b".repeat(2_000) },
    ];
    const kept = selectThreadTail(big);
    expect(kept.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(3_000);
    expect(kept.at(-1)?.text.endsWith("b")).toBe(true);
  });
});

describe("collectWorkspaceFingerprint", () => {
  const withRoot = <A, E>(
    body: (
      root: string,
      fs: FileSystem.FileSystem,
      path: Path.Path,
    ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-refiner-fp-" });
      return yield* body(yield* fs.realPath(root), fs, path);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("lists top-level entries without noise and excerpts the key files", () =>
    withRoot((root, fs, path) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "AGENTS.md"), `开头规则\n${"长".repeat(5_000)}`);
        yield* fs.writeFileString(path.join(root, "README.md"), "项目简介");
        yield* fs.writeFileString(
          path.join(root, "package.json"),
          JSON.stringify({ name: "demo", description: "示例", dependencies: { secret: "1" } }),
        );
        yield* fs.makeDirectory(path.join(root, "apps"));
        yield* fs.makeDirectory(path.join(root, "node_modules"));
        yield* fs.makeDirectory(path.join(root, ".git"));
        yield* fs.makeDirectory(path.join(root, ".local"));
        const fingerprint = yield* collectWorkspaceFingerprint(root);
        expect(fingerprint).toContain("apps/");
        expect(fingerprint).toContain("AGENTS.md");
        expect(fingerprint).toContain("开头规则");
        expect(fingerprint).toContain("项目简介");
        expect(fingerprint).toContain("demo");
        expect(fingerprint).toContain("示例");
        expect(fingerprint).not.toContain("secret");
        expect(fingerprint).not.toContain("node_modules");
        expect(fingerprint).not.toContain(".git");
        expect(fingerprint).not.toContain(".local");
        expect(fingerprint.length).toBeLessThanOrEqual(4_000);
        expect(fingerprint.split("长").length - 1).toBeLessThanOrEqual(1_600);
      }),
    ),
  );

  it.effect("caps the entry list at 40", () =>
    withRoot((root, fs, path) =>
      Effect.gen(function* () {
        for (let index = 0; index < 60; index += 1) {
          yield* fs.writeFileString(path.join(root, `f${String(index).padStart(2, "0")}.txt`), "x");
        }
        const fingerprint = yield* collectWorkspaceFingerprint(root);
        expect(fingerprint).toContain("f39.txt");
        expect(fingerprint).not.toContain("f40.txt");
      }),
    ),
  );

  it.effect("does not follow a symlink that leaves the workspace", () =>
    withRoot((root, fs, path) =>
      Effect.gen(function* () {
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-refiner-outside-" });
        yield* fs.writeFileString(path.join(outside, "secret.md"), "外部机密");
        yield* fs.symlink(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"));
        yield* fs.symlink(outside, path.join(root, "escape"));
        const fingerprint = yield* collectWorkspaceFingerprint(root);
        expect(fingerprint).not.toContain("外部机密");
        expect(fingerprint).not.toContain("escape");
      }),
    ),
  );

  it.effect("degrades to an empty string when the root cannot be read", () =>
    Effect.gen(function* () {
      expect(yield* collectWorkspaceFingerprint("/definitely/not/a/workspace")).toBe("");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("refinePrompt", () => {
  it.effect("returns the refined whole draft and reports workspace context use", () =>
    Effect.gen(function* () {
      const result = yield* refinePrompt(sampler('{"refined":"先核对仓库顶层结构。"}'), {
        draft: SAMPLE_ARCHITECTURE,
        mode: "bold",
        fingerprint: FINGERPRINT,
        threadTail: [],
      });
      expect(result).toEqual({
        refined: "先核对仓库顶层结构。",
        mode: "bold",
        usedWorkspaceContext: true,
      });
    }),
  );

  it.effect("reports no workspace context when none was collected", () =>
    Effect.gen(function* () {
      const result = yield* refinePrompt(sampler('{"refined":"x"}'), {
        draft: SAMPLE_REVIEW,
        mode: "structured",
        fingerprint: "",
        threadTail: [],
      });
      expect(result.usedWorkspaceContext).toBe(false);
    }),
  );

  it.effect("fails with a TextGenerationError when the reply has no usable text", () =>
    Effect.gen(function* () {
      const error = yield* refinePrompt(sampler("not json"), {
        draft: SAMPLE_REVIEW,
        mode: "structured",
        fingerprint: "",
        threadTail: [],
      }).pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
    }),
  );

  it.effect("passes sampler failures through", () =>
    Effect.gen(function* () {
      const failure = new TextGenerationError({
        operation: "samplePromptAdvisor",
        detail: "Antigravity advisor timed out.",
      });
      const error = yield* refinePrompt(sampler(failure), {
        draft: SAMPLE_REVIEW,
        mode: "structured",
        fingerprint: "",
        threadTail: [],
      }).pipe(Effect.flip);
      expect(error).toBe(failure);
    }),
  );
});
