import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/compat";
import { describe, expect } from "vite-plus/test";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AntigravityTextGenerationOptions } from "./AntigravityTextGeneration.ts";
import {
  PROMPT_ADVISOR_PREFIX,
  buildPromptAdvisorPrompt,
  makeAntigravityPromptAdvisorSampler,
  sanitizePromptAdvisorOutput,
  selectPromptAdvisorModel,
  selectPromptAdvisorThinking,
} from "./promptAdvisor.cn.ts";

type TextRuntime = Effect.Success<ReturnType<AntigravityTextGenerationOptions["makeRuntime"]>>;

const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";

const modelOption = (
  currentValue: string,
  values: ReadonlyArray<string>,
): AcpSchema.SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const thinkingOption = (
  currentValue: string,
  values: ReadonlyArray<string>,
): AcpSchema.SessionConfigOption => ({
  id: "thinking_level",
  name: "Thinking level",
  category: "thought_level",
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const item = (kind: string, label: string, fill: string) => ({ kind, label, fill });
const decode = (encoded: string | null) =>
  encoded === null
    ? null
    : (
        JSON.parse(encoded.slice(PROMPT_ADVISOR_PREFIX.length)) as {
          readonly items: ReadonlyArray<{ kind: string; label: string; fill: string }>;
        }
      ).items;
const raw = (...items: ReadonlyArray<ReturnType<typeof item>>) => JSON.stringify({ items });

describe("上下文顾问：协议与清洗", () => {
  it("编码串带固定前缀，条目原样保留", () => {
    const output = sanitizePromptAdvisorOutput(
      raw(item("challenge", "改动没回归验证", "你确认过回归测试覆盖了这次改动吗？")),
      { hasExplicitChoices: false },
    );
    expect(output?.startsWith("\u001et3cn-advisor:v1:")).toBe(true);
    expect(decode(output)).toEqual([
      item("challenge", "改动没回归验证", "你确认过回归测试覆盖了这次改动吗？"),
    ]);
  });

  it("空数组、非 JSON、全被过滤都返回 null", () => {
    expect(sanitizePromptAdvisorOutput('{"items":[]}', { hasExplicitChoices: false })).toBeNull();
    expect(sanitizePromptAdvisorOutput("好的", { hasExplicitChoices: false })).toBeNull();
    expect(
      sanitizePromptAdvisorOutput(raw(item("next", "", "跑一遍测试")), {
        hasExplicitChoices: false,
      }),
    ).toBeNull();
  });

  it("过滤 Delegated task 开头、迎合句、超长项与非法 kind，并按 fill 去重", () => {
    const output = sanitizePromptAdvisorOutput(
      raw(
        item("next", "委派", "Delegated task finished"),
        item("next", "继续", "继续"),
        item("next", "提交", "Looks good, commit it"),
        item("next", "x".repeat(25), "跑一遍完整测试并贴结果"),
        item("angle", "太长", "长".repeat(241)),
        item("praise", "夸夸", "做得很好，请继续保持这个方向"),
        item("next", "跑测试", "跑一遍完整测试并贴结果"),
        item("next", "跑测试", "跑一遍完整测试并贴结果"),
      ),
      { hasExplicitChoices: false },
    );
    expect(decode(output)).toEqual([item("next", "跑测试", "跑一遍完整测试并贴结果")]);
  });

  it("没有显式选项时最多 3 条", () => {
    const output = sanitizePromptAdvisorOutput(
      raw(
        item("challenge", "盲点一", "第一个盲点是什么？"),
        item("next", "动作二", "先验收第二项"),
        item("angle", "视角三", "换成只改一个文件会怎样？"),
        item("next", "动作四", "再补第四项"),
      ),
      { hasExplicitChoices: false },
    );
    expect(decode(output)?.map((entry) => entry.label)).toEqual(["盲点一", "动作二", "视角三"]);
  });

  it("已有显式选项时最多 1 条，且只留 challenge 或 angle", () => {
    const output = sanitizePromptAdvisorOutput(
      raw(
        item("next", "推进", "按乙推进"),
        item("angle", "第三条路", "有没有不拆分的第三种做法？"),
        item("challenge", "漏了回滚", "两个方案都没说怎么回滚？"),
      ),
      { hasExplicitChoices: true },
    );
    expect(decode(output)).toEqual([item("angle", "第三条路", "有没有不拆分的第三种做法？")]);
    expect(
      sanitizePromptAdvisorOutput(raw(item("next", "推进", "按乙推进")), {
        hasExplicitChoices: true,
      }),
    ).toBeNull();
  });
});

describe("上下文顾问：提示词", () => {
  const messages = [
    { role: "user" as const, text: "帮我改一下登录页" },
    { role: "assistant" as const, text: "已改完，测试通过。" },
  ];

  it("要求批判性顾问并跟随用户语言，禁止迎合句", () => {
    const prompt = buildPromptAdvisorPrompt(messages, { hasExplicitChoices: false });
    expect(prompt).toContain("skeptical peer advisor");
    expect(prompt).toContain("language of the latest user message");
    expect(prompt).toContain("looks good, commit it");
    expect(prompt).toContain("0 to 3");
    expect(prompt).toContain("Each request is independent");
    expect(prompt).toContain("USER:\n帮我改一下登录页");
  });

  it("末条回复已有选项时只允许 0–1 条 challenge 或 angle", () => {
    const prompt = buildPromptAdvisorPrompt(messages, { hasExplicitChoices: true });
    expect(prompt).toContain("0 or 1");
    expect(prompt).toContain("never a `next` item");
    expect(prompt).not.toContain("0 to 3");
  });

  it("只取最近 8 条、总长不超过 12000 字符，单条尾截断", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      text: `message-${index}`,
    }));
    const prompt = buildPromptAdvisorPrompt(many, { hasExplicitChoices: false });
    expect(prompt).not.toContain("message-3");
    expect(prompt).toContain("message-4");

    const long = buildPromptAdvisorPrompt(
      [{ role: "assistant", text: `HEAD${"a".repeat(5_000)}TAIL` }],
      { hasExplicitChoices: false },
    );
    expect(long).toContain("[Earlier content truncated]");
    expect(long).toContain("TAIL");
    expect(long).not.toContain("HEAD");

    const heavy = Array.from({ length: 8 }, (_, index) => ({
      role: "assistant" as const,
      text: `${index}`.repeat(4_000),
    }));
    const transcript = buildPromptAdvisorPrompt(heavy, { hasExplicitChoices: false });
    const body = transcript.slice(
      transcript.indexOf("BEGIN CONVERSATION TRANSCRIPT"),
      transcript.indexOf("END CONVERSATION TRANSCRIPT"),
    );
    expect(body.length).toBeLessThan(12_300);
    expect(transcript).toContain("7".repeat(4_000));
  });
});

describe("上下文顾问：模型与思考档位", () => {
  it("按 Neon、Hydrogen、3.8 Flash 的顺序选模型，都没有时回退实例默认", () => {
    const options = (values: ReadonlyArray<string>) => [modelOption(values[0] ?? "x", values)];
    expect(
      selectPromptAdvisorModel(
        options(["gemini-4-hydrogen", "gemini-4-neon", "gemini-3.8-flash"]),
        undefined,
      ),
    ).toBe("gemini-4-neon");
    expect(
      selectPromptAdvisorModel(options(["gemini-3.8-flash", "gemini-4-hydrogen"]), undefined),
    ).toBe("gemini-4-hydrogen");
    expect(selectPromptAdvisorModel(options(["gemini-3.8-flash"]), undefined)).toBe(
      "gemini-3.8-flash",
    );
    expect(selectPromptAdvisorModel(options(["other"]), undefined)).toBeUndefined();
  });

  it("思考档位优先 low，其次 minimal、off、none、medium；已在目标档位则不改", () => {
    expect(
      selectPromptAdvisorThinking([thinkingOption("high", ["minimal", "low", "medium", "high"])]),
    ).toEqual({ id: "thinking_level", value: "low" });
    expect(selectPromptAdvisorThinking([thinkingOption("high", ["minimal", "high"])])).toEqual({
      id: "thinking_level",
      value: "minimal",
    });
    expect(selectPromptAdvisorThinking([thinkingOption("low", ["low", "high"])])).toBeUndefined();
    expect(selectPromptAdvisorThinking([thinkingOption("high", ["high"])])).toBeUndefined();
    expect(selectPromptAdvisorThinking([])).toBeUndefined();
  });
});

const advisorJson = (label: string) => raw(item("next", label, `执行 ${label}`));

const makeFixture = Effect.fn("makePromptAdvisorFixture")(function* (options: {
  readonly outputs: ReadonlyArray<string>;
  readonly hang?: ReadonlyArray<number>;
  readonly writeFileOnPrompt?: ReadonlyArray<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prompt-advisor-test-" });
  const profileDirectory = path.join(root, "profile");
  yield* fs.makeDirectory(profileDirectory, { recursive: true });

  const state = {
    workspaces: [] as Array<string>,
    closed: [] as Array<string>,
    stopped: 0,
    prompts: [] as Array<string>,
    models: [] as Array<string>,
    thinking: [] as Array<string>,
  };
  const outputs = [...options.outputs];
  const hanging = yield* Deferred.make<void>();
  let promptCount = 0;

  const withProcess: AntigravityTextGenerationOptions["withProcess"] = (_stop, task) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const child = yield* Effect.forkIn(task, scope);
      return yield* Fiber.await(child).pipe(
        Effect.flatten,
        Effect.ensuring(Fiber.interrupt(child)),
      );
    });

  const makeRuntime: AntigravityTextGenerationOptions["makeRuntime"] = (cwd) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<AcpSessionRuntime.AcpSessionRuntimeEvent>();
      state.workspaces.push(cwd);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closed.push(cwd);
        }),
      );
      let sessionUpdate: Parameters<TextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;
      let currentModel = "gemini-4-hydrogen";
      let thinkingLevel = "high";
      return {
        start: () =>
          Effect.succeed({
            sessionId: SESSION_ID,
            initializeResult: { protocolVersion: 1 },
            sessionSetupResult: { sessionId: SESSION_ID },
            modelConfigId: "model",
          }),
        setMode: () => Effect.succeed({}),
        getConfigOptions: Effect.sync(() => [
          modelOption(currentModel, ["gemini-4-hydrogen", "gemini-4-neon"]),
          thinkingOption(thinkingLevel, ["minimal", "low", "high"]),
        ]),
        getEvents: () => Stream.fromQueue(events),
        setModel: (model) =>
          Effect.sync(() => {
            state.models.push(model);
            currentModel = model;
          }),
        setConfigOption: (id, value) =>
          Effect.sync(() => {
            if (id === "thinking_level" && typeof value === "string") {
              state.thinking.push(value);
              thinkingLevel = value;
            }
            return { configOptions: [] };
          }),
        prompt: (request) =>
          Effect.gen(function* () {
            const index = promptCount++;
            const first = request.prompt[0];
            state.prompts.push(first?.type === "text" ? first.text : "");
            if (options.hang?.includes(index)) {
              yield* Deferred.succeed(hanging, undefined);
              return yield* Effect.never;
            }
            if (options.writeFileOnPrompt?.includes(index)) {
              yield* fs.writeFileString(path.join(cwd, "leak.txt"), "oops").pipe(Effect.orDie);
            }
            yield* sessionUpdate({
              sessionId: SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: outputs.shift() ?? '{"items":[]}' },
              },
            });
            return { stopReason: "end_turn" as const };
          }),
        cancel: Effect.gen(function* () {
          const acknowledge = yield* Deferred.make<void>();
          yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
          yield* Deferred.await(acknowledge);
        }),
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: () => Effect.void,
        handleElicitation: () => Effect.void,
        handleReadTextFile: () => Effect.void,
        handleWriteTextFile: () => Effect.void,
        handleCreateTerminal: () => Effect.void,
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: () => Effect.void,
      } satisfies TextRuntime;
    });

  const stopTracked: AntigravityTextGenerationOptions["withProcess"] = (stop, task) =>
    withProcess(
      stop.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            state.stopped += 1;
          }),
        ),
      ),
      task,
    );

  const advisor = yield* makeAntigravityPromptAdvisorSampler({
    profileDirectory,
    defaultModel: Effect.succeed("gemini-instance-default"),
    makeRuntime,
    withProcess: stopTracked,
  });
  const ask = (hasExplicitChoices = false) =>
    advisor.sample({
      messages: [
        { role: "user", text: "改一下" },
        { role: "assistant", text: "改完了" },
      ],
      hasExplicitChoices,
    });
  return { state, advisor, ask, hanging };
});

describe("上下文顾问：温进程", () => {
  it.layer(NodeServices.layer)("复用与销毁", (it) => {
    it.effect("连续请求复用同一进程，选 Neon 与 low，只建一次工作目录", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲"), advisorJson("乙")] });
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("甲");
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("乙");
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.models).toEqual(["gemini-4-neon"]);
        expect(fixture.state.thinking).toEqual(["low"]);
        expect(fixture.state.prompts).toHaveLength(2);
        expect(fixture.state.prompts[0]).toContain("Use only the input below");
      }).pipe(Effect.scoped),
    );

    it.effect("复用满 20 次后销毁，下一次重新建进程", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: Array.from({ length: 21 }, (_, index) => advisorJson(`n${index}`)),
        });
        for (let index = 0; index < 20; index += 1) yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.closed).toEqual(fixture.state.workspaces);
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(2);
      }).pipe(Effect.scoped),
    );

    it.effect("空闲 5 分钟后销毁进程，再来请求时重建", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲"), advisorJson("乙")] });
        yield* fixture.ask();
        yield* TestClock.adjust(Duration.minutes(4));
        expect(fixture.state.closed).toHaveLength(0);
        yield* TestClock.adjust(Duration.minutes(2));
        expect(fixture.state.closed).toHaveLength(1);
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(2);
      }).pipe(Effect.scoped),
    );

    it.effect("单次 30 秒超时立刻销毁，下一次请求重建而不复用坏进程", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("乙")], hang: [0] });
        const first = yield* Effect.forkChild(Effect.exit(fixture.ask()));
        yield* Deferred.await(fixture.hanging);
        yield* TestClock.adjust(Duration.seconds(31));
        const exit = yield* Fiber.join(first);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(fixture.state.closed).toHaveLength(1);
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("乙");
        expect(fixture.state.workspaces).toHaveLength(2);
      }).pipe(Effect.scoped),
    );

    it.effect("采样被外部中断时同样销毁进程，下一次请求重建", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("乙")], hang: [0] });
        const first = yield* Effect.forkChild(fixture.ask());
        yield* Deferred.await(fixture.hanging);
        yield* Fiber.interrupt(first);
        expect(fixture.state.closed).toHaveLength(1);
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("乙");
        expect(fixture.state.workspaces).toHaveLength(2);
      }).pipe(Effect.scoped),
    );

    it.effect("工作目录被写入文件时报错并销毁进程", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), advisorJson("乙")],
          writeFileOnPrompt: [0],
        });
        const exit = yield* Effect.exit(fixture.ask());
        expect(Exit.isFailure(exit)).toBe(true);
        expect(fixture.state.closed).toHaveLength(1);
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("乙");
      }).pipe(Effect.scoped),
    );

    it.effect("关闭所属 Scope 时销毁温进程", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲")] }).pipe(
          Scope.provide(scope),
        );
        yield* fixture.ask();
        expect(fixture.state.closed).toHaveLength(0);
        yield* Scope.close(scope, Exit.void);
        expect(fixture.state.closed).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
  });
});
