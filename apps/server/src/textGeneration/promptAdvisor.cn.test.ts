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
  previewPromptAdvisorPrompt,
  readPromptAdvisorOutput,
  UNPARSEABLE_OUTPUT_MESSAGE,
} from "./promptAdvisor.cn.ts";
import {
  DEFAULT_PROMPT_ADVISOR_CONFIG,
  type PromptAdvisorConfig,
  type RoleModelSelection,
  setPromptAdvisorConfig,
  targetSignature,
} from "./promptAdvisorConfig.cn.ts";
import {
  registerPromptAdvisor,
  releasePromptAdvisorSlots,
  retainPromptAdvisorSlots,
} from "./promptAdvisorRegistry.cn.ts";

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
  readonly config?: PromptAdvisorConfig;
  /** The prompt with this index waits at the gate until the test opens it, then answers normally. */
  readonly gate?: number;
  /** Leave the sampler on the process-wide config, as production does. */
  readonly globalConfig?: boolean;
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
    helpers: [] as Array<{ cwd: string; model: string; thinking: string }>,
  };
  const config = { value: options.config ?? DEFAULT_PROMPT_ADVISOR_CONFIG };
  const outputs = [...options.outputs];
  const hanging = yield* Deferred.make<void>();
  const gateReached = yield* Deferred.make<void>();
  const gateOpen = yield* Deferred.make<void>();
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
      const helper = { cwd, model: currentModel, thinking: thinkingLevel };
      state.helpers.push(helper);
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
          modelOption(currentModel, ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"]),
          thinkingOption(thinkingLevel, ["minimal", "low", "high"]),
        ]),
        getEvents: () => Stream.fromQueue(events),
        setModel: (model) =>
          Effect.sync(() => {
            state.models.push(model);
            currentModel = model;
            helper.model = model;
          }),
        setConfigOption: (id, value) =>
          Effect.sync(() => {
            if (id === "thinking_level" && typeof value === "string") {
              state.thinking.push(value);
              thinkingLevel = value;
              helper.thinking = value;
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
            if (options.gate === index) {
              yield* Deferred.succeed(gateReached, undefined);
              yield* Deferred.await(gateOpen);
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

  const advisor = yield* makeAntigravityPromptAdvisorSampler(
    {
      profileDirectory,
      defaultModel: Effect.succeed("gemini-instance-default"),
      makeRuntime,
      withProcess: stopTracked,
    },
    ...(options.globalConfig === true ? [] : [() => config.value]),
  );
  const ask = (hasExplicitChoices = false) =>
    advisor.sample({
      messages: [
        { role: "user", text: "改一下" },
        { role: "assistant", text: "改完了" },
      ],
      hasExplicitChoices,
    });
  return { state, advisor, ask, hanging, config, gateReached, gateOpen };
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

    it.effect("提示词优化与顾问采样共用同一个温进程并共享复用计数", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), '{"refined":"优化稿"}'],
        });
        yield* fixture.ask();
        expect(yield* fixture.advisor.runPrompt("rewrite this draft")).toBe('{"refined":"优化稿"}');
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.prompts).toHaveLength(2);
        expect(fixture.state.prompts[1]).toContain("Use only the input below");
        expect(fixture.state.prompts[1]).toContain("rewrite this draft");
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

const selection = (patch: Partial<RoleModelSelection>): RoleModelSelection => ({
  instanceId: null,
  model: null,
  thinking: null,
  ...patch,
});

const configFor = (options: {
  readonly advisor?: Partial<RoleModelSelection>;
  /** Present: the refiner stops following the advisor and runs on this. */
  readonly refiner?: Partial<RoleModelSelection>;
}): PromptAdvisorConfig => ({
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  advisor: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
    runtime: selection(options.advisor ?? {}),
  },
  refiner: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
    followAdvisorRuntime: options.refiner === undefined,
    runtime: selection(options.refiner ?? {}),
  },
});

const REFINED = '{"refined":"优化稿"}';
const signature = (patch: Partial<RoleModelSelection>) => targetSignature(selection(patch));

describe("上下文顾问：四阶段镜片与可替换提示词", () => {
  const messages = [
    { role: "user" as const, text: "测试挂了，帮我修" },
    { role: "assistant" as const, text: "我先把断言改成通过。" },
  ];
  const advisorWith = (patch: Partial<PromptAdvisorConfig["advisor"]>) => ({
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
    ...patch,
  });

  it("三个镜片默认全开，各自只受自己的开关控制", () => {
    const all = buildPromptAdvisorPrompt(messages, { hasExplicitChoices: false });
    expect(all).toContain("Decision frontier and subtraction");
    expect(all).toContain("Root cause first");
    expect(all).toContain("Blast radius");
    for (const [key, marker] of [
      ["grilling", "Decision frontier and subtraction"],
      ["debugging", "Root cause first"],
      ["blastRadius", "Blast radius"],
    ] as const) {
      const off = buildPromptAdvisorPrompt(messages, {
        hasExplicitChoices: false,
        config: advisorWith({
          lenses: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor.lenses, [key]: false },
        }),
      });
      expect(off).not.toContain(marker);
      expect(off).toContain("You are a skeptical peer advisor");
    }
  });

  it("镜片全关时回到原有的无镜片提示词", () => {
    const prompt = buildPromptAdvisorPrompt(messages, {
      hasExplicitChoices: false,
      config: advisorWith({ lenses: { grilling: false, debugging: false, blastRadius: false } }),
    });
    expect(prompt).not.toContain("First decide which stage");
    expect(prompt).not.toContain("Decision frontier");
    expect(prompt).toContain("`challenge`: a pointed question");
  });

  it("一键杠杆用自然语言指令，不写斜杠命令或 Skill 名", () => {
    const prompt = buildPromptAdvisorPrompt(messages, { hasExplicitChoices: false });
    expect(prompt).toContain("plain-language instruction the coding agent can carry out");
    expect(prompt).toContain("Never write slash commands or skill names");
    expect(prompt).not.toMatch(/\/grill-me|systematic-debugging|blast-radius/);
  });

  it("已有显式选项时不出杠杆，仍只允许 0–1 条且不出 next", () => {
    const prompt = buildPromptAdvisorPrompt(messages, { hasExplicitChoices: true });
    expect(prompt).toContain("Root cause first");
    expect(prompt).not.toContain("plain-language instruction the coding agent can carry out");
    expect(prompt).toContain("Return 0 or 1 items, never a `next` item");
    expect(prompt).not.toContain("0 to 3");
  });

  it("补充指令追加在内置指令之后、输出格式之前", () => {
    const prompt = buildPromptAdvisorPrompt(messages, {
      hasExplicitChoices: false,
      config: advisorWith({ customAppendix: "多问迁移风险。" }),
    });
    expect(prompt.indexOf("多问迁移风险。")).toBeGreaterThan(prompt.indexOf("Blast radius"));
    expect(prompt.indexOf("多问迁移风险。")).toBeLessThan(prompt.indexOf("Return a JSON object"));
  });

  it("全文覆盖只换思考指令，输出格式、红线与定界符仍由代码包裹", () => {
    for (const hasExplicitChoices of [false, true]) {
      const prompt = buildPromptAdvisorPrompt(messages, {
        hasExplicitChoices,
        config: advisorWith({ promptOverride: "只挑最尖锐的一个问题。" }),
      });
      expect(prompt.startsWith("只挑最尖锐的一个问题。")).toBe(true);
      expect(prompt).not.toContain("You are a skeptical peer advisor");
      expect(prompt).not.toContain("Root cause first");
      expect(prompt).toContain('Return a JSON object: {"items"');
      expect(prompt).toContain("at most 24 characters");
      expect(prompt).toContain("at most 240 characters");
      expect(prompt).toContain('Never output empty agreement such as "continue"');
      expect(prompt).toContain("Never write internal system or delegated-task notifications.");
      expect(prompt).toContain("Each request is independent.");
      expect(prompt).toContain("BEGIN CONVERSATION TRANSCRIPT");
      expect(prompt).toContain("END CONVERSATION TRANSCRIPT");
      expect(prompt).toContain(
        hasExplicitChoices ? "never a `next` item" : "Return 0 to 3 substantive items",
      );
    }
  });

  it("预览与真实请求是同一个构造，只有会话部分被占位", () => {
    for (const hasExplicitChoices of [false, true]) {
      const config = advisorWith({
        customAppendix: "追加",
        lenses: { grilling: true, debugging: false, blastRadius: true },
      });
      const real = buildPromptAdvisorPrompt(messages, { hasExplicitChoices, config });
      const preview = previewPromptAdvisorPrompt({ hasExplicitChoices, config });
      const transcript = real.slice(
        real.indexOf("BEGIN CONVERSATION TRANSCRIPT"),
        real.indexOf("END CONVERSATION TRANSCRIPT"),
      );
      const stand = preview.slice(
        preview.indexOf("BEGIN CONVERSATION TRANSCRIPT"),
        preview.indexOf("END CONVERSATION TRANSCRIPT"),
      );
      expect(real.replace(transcript, "").replace(/\n+/g, "\n")).toBe(
        preview.replace(stand, "").replace(/\n+/g, "\n"),
      );
      expect(stand).toContain("inserted here");
    }
  });
});

describe("上下文顾问：目标模型选择", () => {
  const options = [
    modelOption("gemini-4-hydrogen", ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"]),
  ];

  it("请求的模型可用时优先，不可用或为空时回到自动优选", () => {
    expect(selectPromptAdvisorModel(options, undefined, "gemini-4-carbon")).toBe("gemini-4-carbon");
    expect(selectPromptAdvisorModel(options, undefined, "gemini-9")).toBe("gemini-4-neon");
    expect(selectPromptAdvisorModel(options, undefined, null)).toBe("gemini-4-neon");
  });

  it("请求的思考档可用时优先（忽略大小写），否则回到自动优选", () => {
    const thinking = [thinkingOption("high", ["minimal", "low", "medium", "high"])];
    expect(selectPromptAdvisorThinking(thinking, "MEDIUM")).toEqual({
      id: "thinking_level",
      value: "medium",
    });
    expect(selectPromptAdvisorThinking(thinking, "ultra")).toEqual({
      id: "thinking_level",
      value: "low",
    });
    expect(selectPromptAdvisorThinking(thinking, "high")).toBeUndefined();
  });
});

describe("上下文顾问：按需共享与隔离的温槽", () => {
  it.layer(NodeServices.layer)("温槽", (it) => {
    it.effect("冷态 inspect 只读内存，不启动进程也不查模型", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [] });
        const inspection = yield* fixture.advisor.inspect;
        expect(inspection).toMatchObject({ available: true, slots: [] });
        expect(inspection.activity.advisor).toEqual({
          lastSampleAt: null,
          lastDurationMs: null,
          lastError: null,
        });
        yield* fixture.advisor.inspect;
        expect(fixture.state.workspaces).toHaveLength(0);
        expect(fixture.state.prompts).toHaveLength(0);
      }).pipe(Effect.scoped),
    );

    it.effect("跑过之后 inspect 汇报实测模型、思考档、可选项与复用次数", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲"), REFINED] });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        const inspection = yield* fixture.advisor.inspect;
        expect(inspection.slots).toEqual([
          {
            signature: signature({}),
            warm: true,
            uses: 2,
            live: {
              activeModel: "gemini-4-neon",
              activeThinking: "low",
              availableModels: ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"],
              availableThinking: ["minimal", "low", "high"],
            },
          },
        ]);
        for (const role of ["advisor", "refiner"] as const) {
          expect(inspection.activity[role].lastError).toBeNull();
          expect(inspection.activity[role].lastSampleAt).not.toBeNull();
          expect(inspection.activity[role].lastDurationMs).not.toBeNull();
        }
      }).pipe(Effect.scoped),
    );

    it.effect("空闲回收后仍记得实测选项，但不再是热的", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲")] });
        yield* fixture.ask();
        yield* TestClock.adjust(Duration.minutes(6));
        const slot = (yield* fixture.advisor.inspect).slots[0];
        expect(slot?.warm).toBe(false);
        expect(slot?.uses).toBe(0);
        expect(slot?.live.activeModel).toBe("gemini-4-neon");
      }).pipe(Effect.scoped),
    );

    it.effect("失败只记在发起失败的角色上", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("乙")], hang: [0] });
        const first = yield* Effect.forkChild(Effect.exit(fixture.advisor.runPrompt("rewrite")));
        yield* Deferred.await(fixture.hanging);
        yield* TestClock.adjust(Duration.seconds(31));
        yield* Fiber.join(first);
        const { activity } = yield* fixture.advisor.inspect;
        expect(activity.refiner.lastError).toBe("Antigravity advisor timed out.");
        expect(activity.advisor.lastError).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("相同配置共用同一个温槽：只起一个进程，复用计数合并", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙")],
          config: configFor({ advisor: { model: "gemini-4-carbon", thinking: "high" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.helpers[0]).toMatchObject({
          model: "gemini-4-carbon",
          thinking: "high",
        });
        expect((yield* fixture.advisor.inspect).slots[0]?.uses).toBe(3);
      }).pipe(Effect.scoped),
    );

    it.effect("不同配置各用独立温槽，互不切模型", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙"), REFINED],
          config: configFor({ refiner: { model: "gemini-4-hydrogen", thinking: "high" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite again");
        expect(fixture.state.workspaces).toHaveLength(2);
        expect(fixture.state.helpers.map(({ model, thinking }) => ({ model, thinking }))).toEqual([
          { model: "gemini-4-neon", thinking: "low" },
          { model: "gemini-4-hydrogen", thinking: "high" },
        ]);
        const { slots } = yield* fixture.advisor.inspect;
        expect(slots.map(({ uses }) => uses)).toEqual([2, 2]);
        expect(fixture.state.closed).toHaveLength(0);
      }).pipe(Effect.scoped),
    );

    it.effect("独立温槽有独立的锁：顾问卡住时优化照常返回", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [REFINED],
          hang: [0],
          config: configFor({ refiner: { model: "gemini-4-carbon" } }),
        });
        const blocked = yield* Effect.forkChild(Effect.exit(fixture.ask()));
        yield* Deferred.await(fixture.hanging);
        expect(yield* fixture.advisor.runPrompt("rewrite")).toBe(REFINED);
        yield* Fiber.interrupt(blocked);
      }).pipe(Effect.scoped),
    );

    it.effect("改顾问配置只释放顾问旧槽，独立的优化槽原样保留", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙"), REFINED],
          config: configFor({ refiner: { model: "gemini-4-hydrogen", thinking: "high" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        const [advisorHelper, refinerHelper] = fixture.state.helpers;

        fixture.config.value = configFor({
          advisor: { model: "gemini-4-carbon", thinking: "high" },
          refiner: { model: "gemini-4-hydrogen", thinking: "high" },
        });
        yield* fixture.advisor.retain(
          new Set([
            signature({ model: "gemini-4-carbon", thinking: "high" }),
            signature({ model: "gemini-4-hydrogen", thinking: "high" }),
          ]),
        );
        expect(fixture.state.closed).toEqual([advisorHelper?.cwd]);

        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite again");
        expect(fixture.state.workspaces).toHaveLength(3);
        expect(fixture.state.closed).not.toContain(refinerHelper?.cwd);
        const slots = (yield* fixture.advisor.inspect).slots;
        expect(
          slots.find(
            ({ signature: key }) =>
              key === signature({ model: "gemini-4-hydrogen", thinking: "high" }),
          )?.uses,
        ).toBe(2);
      }).pipe(Effect.scoped),
    );

    it.effect("改优化配置只释放优化旧槽，顾问槽与它的复用计数不受影响", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙")],
          config: configFor({ refiner: { model: "gemini-4-hydrogen", thinking: "high" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        const [advisorHelper, refinerHelper] = fixture.state.helpers;

        fixture.config.value = configFor({ refiner: { model: "gemini-4-carbon" } });
        yield* fixture.advisor.retain(
          new Set([signature({}), signature({ model: "gemini-4-carbon" })]),
        );
        expect(fixture.state.closed).toEqual([refinerHelper?.cwd]);
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(2);
        expect(fixture.state.closed).not.toContain(advisorHelper?.cwd);
        expect(
          (yield* fixture.advisor.inspect).slots.find(({ signature: key }) => key === signature({}))
            ?.uses,
        ).toBe(2);
      }).pipe(Effect.scoped),
    );

    it.effect("只改提示词或镜片的配置不动任何温槽", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲"), advisorJson("乙")] });
        yield* fixture.ask();
        fixture.config.value = {
          ...fixture.config.value,
          advisor: {
            ...fixture.config.value.advisor,
            lenses: { grilling: false, debugging: false, blastRadius: true },
            customAppendix: "新的补充",
          },
        };
        yield* fixture.advisor.retain(new Set([signature({})]));
        yield* fixture.ask();
        expect(fixture.state.closed).toHaveLength(0);
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.prompts[1]).toContain("新的补充");
        expect(fixture.state.prompts[1]).not.toContain("Decision frontier");
      }).pipe(Effect.scoped),
    );

    it.effect("共用槽拆开后顾问继续用原槽，优化懒启动自己的槽", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), advisorJson("乙"), REFINED],
        });
        yield* fixture.ask();
        fixture.config.value = configFor({ refiner: { model: "gemini-4-carbon" } });
        yield* fixture.advisor.retain(
          new Set([signature({}), signature({ model: "gemini-4-carbon" })]),
        );
        expect(fixture.state.closed).toHaveLength(0);
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(1);
        yield* fixture.advisor.runPrompt("rewrite");
        expect(fixture.state.workspaces).toHaveLength(2);
        expect(fixture.state.helpers[1]).toMatchObject({ model: "gemini-4-carbon" });
      }).pipe(Effect.scoped),
    );

    it.effect("销毁等当前提示词跑完：进行中的槽被撤销后随请求结束释放", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲")],
          hang: [0],
          config: configFor({ refiner: { model: "gemini-4-carbon" } }),
        });
        const running = yield* Effect.forkChild(Effect.exit(fixture.ask()));
        yield* Deferred.await(fixture.hanging);
        yield* fixture.advisor.retain(new Set([signature({ model: "gemini-4-carbon" })]));
        expect(fixture.state.closed).toHaveLength(0);
        yield* Fiber.interrupt(running);
        expect(fixture.state.closed).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("请求的模型不存在时回退自动优选", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲")],
          config: configFor({ advisor: { model: "gemini-9", thinking: "ultra" } }),
        });
        yield* fixture.ask();
        expect(fixture.state.helpers[0]).toMatchObject({ model: "gemini-4-neon", thinking: "low" });
      }).pipe(Effect.scoped),
    );

    it.effect("同时在用的温槽不超过两个", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙")],
          config: configFor({ refiner: { model: "gemini-4-hydrogen" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        fixture.config.value = configFor({
          advisor: { model: "gemini-4-carbon" },
          refiner: { model: "gemini-4-hydrogen" },
        });
        yield* fixture.ask();
        expect(fixture.state.workspaces).toHaveLength(3);
        expect(fixture.state.workspaces.length - fixture.state.closed.length).toBeLessThanOrEqual(
          2,
        );
      }).pipe(Effect.scoped),
    );
  });
});

describe("上下文顾问：按签名释放温槽", () => {
  it.layer(NodeServices.layer)("释放", (it) => {
    it.effect("共用槽被释放后，两个角色下一次都从干净会话开始", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙"), REFINED],
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        yield* fixture.advisor.release(new Set([signature({})]));
        expect(fixture.state.closed).toHaveLength(1);
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite again");
        expect(fixture.state.workspaces).toHaveLength(2);
        expect((yield* fixture.advisor.inspect).slots[0]?.uses).toBe(2);
      }).pipe(Effect.scoped),
    );

    it.effect("只释放顾问的签名时，独立的优化槽原样保留", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙"), REFINED],
          config: configFor({ refiner: { model: "gemini-4-hydrogen", thinking: "high" } }),
        });
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        const [advisorHelper, refinerHelper] = fixture.state.helpers;
        yield* fixture.advisor.release(new Set([signature({})]));
        expect(fixture.state.closed).toEqual([advisorHelper?.cwd]);
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite again");
        expect(fixture.state.workspaces).toHaveLength(3);
        expect(fixture.state.closed).not.toContain(refinerHelper?.cwd);
      }).pipe(Effect.scoped),
    );

    it.effect("忙碌的槽被释放后，同签名的新请求不会复用旧进程", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED],
          gate: 0,
        });
        const first = yield* Effect.forkChild(fixture.ask());
        yield* Deferred.await(fixture.gateReached);
        yield* fixture.advisor.release(new Set([signature({})]));
        expect(fixture.state.closed).toHaveLength(0);
        const second = yield* Effect.forkChild(fixture.advisor.runPrompt("rewrite"));
        yield* Deferred.succeed(fixture.gateOpen, undefined);
        yield* Fiber.join(first);
        expect(yield* Fiber.join(second)).toBe(REFINED);
        const [oldHelper, newHelper] = fixture.state.helpers;
        expect(fixture.state.helpers).toHaveLength(2);
        expect(fixture.state.closed).toEqual([oldHelper?.cwd]);
        expect(fixture.state.closed).not.toContain(newHelper?.cwd);
      }).pipe(Effect.scoped),
    );

    it.effect("忙碌的槽被撤出保留集后，排在后面的请求也从新进程开始", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), advisorJson("乙")],
          gate: 0,
        });
        const first = yield* Effect.forkChild(fixture.ask());
        yield* Deferred.await(fixture.gateReached);
        yield* fixture.advisor.retain(new Set());
        const second = yield* Effect.forkChild(fixture.ask());
        yield* Deferred.succeed(fixture.gateOpen, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(fixture.state.helpers).toHaveLength(2);
        expect(fixture.state.closed).toEqual([fixture.state.helpers[0]?.cwd]);
      }).pipe(Effect.scoped),
    );

    it.effect("释放没有对应槽的签名什么都不做", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: [advisorJson("甲")] });
        yield* fixture.advisor.release(new Set([signature({ model: "gemini-4-carbon" })]));
        yield* fixture.ask();
        yield* fixture.advisor.release(new Set([signature({ model: "gemini-4-carbon" })]));
        expect(fixture.state.closed).toHaveLength(0);
      }).pipe(Effect.scoped),
    );
  });
});

describe("上下文顾问：注册表与进程内配置的端到端", () => {
  it.layer(NodeServices.layer)("生产路径", (it) => {
    it.effect("保留集与释放集由注册表按当前配置算出，关掉的正是该关的进程", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED, advisorJson("乙"), REFINED],
          globalConfig: true,
        });
        yield* registerPromptAdvisor("antigravity", fixture.advisor);
        const apart = configFor({ refiner: { model: "gemini-4-hydrogen", thinking: "high" } });
        yield* Effect.acquireRelease(
          Effect.sync(() => setPromptAdvisorConfig(apart)),
          () => Effect.sync(() => setPromptAdvisorConfig(DEFAULT_PROMPT_ADVISOR_CONFIG)),
        );
        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite");
        const [advisorHelper, refinerHelper] = fixture.state.helpers;
        expect(fixture.state.helpers).toHaveLength(2);

        const advisorMoved = configFor({
          advisor: { model: "gemini-4-carbon" },
          refiner: { model: "gemini-4-hydrogen", thinking: "high" },
        });
        setPromptAdvisorConfig(advisorMoved);
        yield* retainPromptAdvisorSlots(advisorMoved);
        expect(fixture.state.closed).toEqual([advisorHelper?.cwd]);

        const refinerReworded: PromptAdvisorConfig = {
          ...advisorMoved,
          refiner: {
            ...advisorMoved.refiner,
            modeOverrides: { ...advisorMoved.refiner.modeOverrides, bold: "只发散" },
          },
        };
        setPromptAdvisorConfig(refinerReworded);
        yield* releasePromptAdvisorSlots(refinerReworded, ["refiner"]);
        expect(fixture.state.closed).toEqual([advisorHelper?.cwd, refinerHelper?.cwd]);

        yield* fixture.ask();
        yield* fixture.advisor.runPrompt("rewrite again");
        expect(fixture.state.helpers.map(({ model }) => model)).toEqual([
          "gemini-4-neon",
          "gemini-4-hydrogen",
          "gemini-4-carbon",
          "gemini-4-hydrogen",
        ]);
      }).pipe(Effect.scoped),
    );
  });
});

describe("上下文顾问：区分解析失败与合法空结果", () => {
  const options = { hasExplicitChoices: false };

  it("不是约定 JSON 的输出读成 Unparseable，并带最多 240 字符的原文摘录", () => {
    const long = "我觉得可以这样做。".repeat(60);
    const reading = readPromptAdvisorOutput(long, options);
    expect(reading._tag).toBe("Unparseable");
    expect(reading._tag === "Unparseable" && reading.excerpt).toBe(long.slice(0, 240));
    expect(readPromptAdvisorOutput('{"items":"oops"}', options)._tag).toBe("Unparseable");
    expect(readPromptAdvisorOutput("", options)).toEqual({ _tag: "Unparseable", excerpt: "" });
  });

  it("合法的空数组是 Parsed：没收到条目，也没丢条目", () => {
    expect(readPromptAdvisorOutput('{"items":[]}', options)).toEqual({
      _tag: "Parsed",
      encoded: null,
      received: 0,
      dropped: 0,
    });
  });

  it("全部被规则过滤时 encoded 为空，但收到与丢弃的条数照实报告", () => {
    const reading = readPromptAdvisorOutput(
      raw(item("next", "继续", "继续"), item("angle", "太长", "长".repeat(241))),
      options,
    );
    expect(reading).toEqual({ _tag: "Parsed", encoded: null, received: 2, dropped: 2 });
  });

  it("部分被过滤时保留其余条目并报告丢弃数", () => {
    const reading = readPromptAdvisorOutput(
      raw(item("challenge", "盲点", "你验证过吗？"), item("next", "继续", "继续")),
      options,
    );
    expect(reading._tag === "Parsed" && reading.dropped).toBe(1);
    expect(reading._tag === "Parsed" && decode(reading.encoded)).toEqual([
      item("challenge", "盲点", "你验证过吗？"),
    ]);
  });

  it("旧的 sanitize 对三种情形仍一律返回 null", () => {
    expect(sanitizePromptAdvisorOutput("随便说点什么", options)).toBeNull();
    expect(sanitizePromptAdvisorOutput('{"items":[]}', options)).toBeNull();
    expect(sanitizePromptAdvisorOutput(raw(item("next", "继续", "继续")), options)).toBeNull();
  });

  it.layer(NodeServices.layer)("采样器", (it) => {
    it.effect("无法解析时仍安全返回 null，但把原因写进顾问的 lastError，下一次成功后清掉", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: ["我觉得可以先看看。", advisorJson("乙")],
        });
        expect(yield* fixture.ask()).toBeNull();
        const failed = (yield* fixture.advisor.inspect).activity;
        expect(failed.advisor.lastError).toBe(UNPARSEABLE_OUTPUT_MESSAGE);
        expect(failed.advisor.lastSampleAt).not.toBeNull();
        expect(failed.refiner.lastError).toBeNull();
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("乙");
        expect((yield* fixture.advisor.inspect).activity.advisor.lastError).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("合法的空结果与全被过滤都不算错误", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: ['{"items":[]}', raw(item("next", "继续", "继续"))],
        });
        expect(yield* fixture.ask()).toBeNull();
        expect(yield* fixture.ask()).toBeNull();
        expect((yield* fixture.advisor.inspect).activity.advisor.lastError).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("sampleDetailed 交出读数：解析失败带摘录，合法空结果没有", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ outputs: ["not json at all", '{"items":[]}'] });
        const input = {
          messages: [
            { role: "user" as const, text: "改一下" },
            { role: "assistant" as const, text: "改完了" },
          ],
          hasExplicitChoices: false,
        };
        expect(yield* fixture.advisor.sampleDetailed(input)).toEqual({
          _tag: "Unparseable",
          excerpt: "not json at all",
        });
        expect(yield* fixture.advisor.sampleDetailed(input)).toMatchObject({
          _tag: "Parsed",
          received: 0,
        });
      }).pipe(Effect.scoped),
    );
  });
});

describe("上下文顾问：一次性隔离运行", () => {
  it.layer(NodeServices.layer)("试跑草稿", (it) => {
    it.effect("用草稿的目标另起进程，跑完即关，不动温槽的会话、计数与活动记录", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲"), REFINED],
        });
        yield* fixture.ask();
        const before = yield* fixture.advisor.inspect;
        const result = yield* fixture.advisor.runIsolated(
          "draft prompt",
          selection({ model: "gemini-4-carbon", thinking: "high" }),
        );
        expect(result.output).toBe(REFINED);
        expect(result.live.activeModel).toBe("gemini-4-carbon");
        expect(result.live.activeThinking).toBe("high");
        const [warmHelper, trialHelper] = fixture.state.helpers;
        expect(trialHelper).toMatchObject({ model: "gemini-4-carbon", thinking: "high" });
        expect(fixture.state.closed).toEqual([trialHelper?.cwd]);
        expect(fixture.state.closed).not.toContain(warmHelper?.cwd);
        expect(fixture.state.prompts[1]).toContain("draft prompt");
        const after = yield* fixture.advisor.inspect;
        expect(after).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("一次性运行失败也关掉自己的进程，温槽照常可用", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          outputs: [advisorJson("甲")],
          hang: [0],
        });
        const trial = yield* Effect.forkChild(
          Effect.exit(fixture.advisor.runIsolated("draft", selection({}))),
        );
        yield* Deferred.await(fixture.hanging);
        yield* TestClock.adjust(Duration.seconds(31));
        expect((yield* Fiber.join(trial))._tag).toBe("Failure");
        expect(fixture.state.closed).toHaveLength(1);
        expect(decode(yield* fixture.ask())?.[0]?.label).toBe("甲");
        expect((yield* fixture.advisor.inspect).slots[0]?.warm).toBe(true);
      }).pipe(Effect.scoped),
    );
  });
});
