import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect } from "vite-plus/test";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AntigravityTextGenerationOptions } from "./AntigravityTextGeneration.ts";
import {
  ANTIGRAVITY_PROMPT_SUGGESTION_MODEL_PREFERENCE,
  buildAntigravityPromptSuggestionPrompt,
  makeAntigravityPromptSuggestionSampler,
  sanitizeAntigravityPromptSuggestion,
  selectAntigravityPromptSuggestionModel,
  selectLowestAntigravityThinkingLevel,
} from "./antigravityPromptSuggestion.cn.ts";

type TextRuntime = Effect.Success<ReturnType<AntigravityTextGenerationOptions["makeRuntime"]>>;

const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
const instanceId = ProviderInstanceId.make("antigravity-suggestion-test");
const encodeMetadata = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

const makeModelConfigOption = (
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

const makeThinkingConfigOption = (
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

const makeSamplerFixture = Effect.fn("makeAntigravityPromptSuggestionFixture")(function* (options: {
  readonly outputs: ReadonlyArray<string>;
  readonly availableModels: ReadonlyArray<string>;
  readonly initialModel?: string;
  readonly thinkingValues?: ReadonlyArray<string>;
  readonly initialThinking?: string;
  readonly onPrompt?: (index: number) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-suggestion-test-" });
  const profileDirectory = path.join(root, "profile");
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  const sessionBase = path.join(conversations, SESSION_ID);
  const brainDirectory = path.join(profileDirectory, "antigravity-acp", "brain", SESSION_ID);
  yield* fs.makeDirectory(conversations, { recursive: true });
  yield* fs.writeFileString(path.join(conversations, "user-session.db"), "keep native history");

  const state = {
    workspaces: [] as Array<string>,
    closed: [] as Array<string>,
    prompts: [] as Array<Parameters<TextRuntime["prompt"]>[0]>,
    selectedModels: [] as Array<string>,
    thinkingUpdates: [] as Array<string>,
    promptModels: [] as Array<string>,
    promptThinkingLevels: [] as Array<string>,
  };
  const outputs = [...options.outputs];
  let closedSignal = yield* Deferred.make<void>();
  let promptIndex = 0;

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
        }).pipe(
          Effect.andThen(Deferred.succeed(closedSignal, undefined)),
          Effect.andThen(
            Effect.flatMap(Deferred.make<void>(), (next) =>
              Effect.sync(() => {
                closedSignal = next;
              }),
            ),
          ),
        ),
      );
      let sessionUpdate: Parameters<TextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;
      let currentModel = options.initialModel ?? options.availableModels[0] ?? "gemini-4-neon";
      let thinkingLevel = options.initialThinking ?? "high";
      const thinkingValues = options.thinkingValues ?? ["minimal", "low", "high"];

      return {
        start: () =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(brainDirectory, { recursive: true });
            yield* fs.writeFileString(`${sessionBase}.db`, "helper session");
            yield* fs.writeFileString(`${sessionBase}.db-wal`, "helper journal");
            const metadata = yield* encodeMetadata({ cwd });
            yield* fs.writeFileString(`${sessionBase}.meta`, metadata);
            yield* fs.writeFileString(path.join(brainDirectory, "output.txt"), "helper artifact");
            return {
              sessionId: SESSION_ID,
              initializeResult: { protocolVersion: 1 },
              sessionSetupResult: { sessionId: SESSION_ID },
              modelConfigId: "model",
            };
          }).pipe(Effect.orDie),
        setMode: () => Effect.succeed({}),
        getConfigOptions: Effect.sync(() => [
          makeModelConfigOption(currentModel, options.availableModels),
          makeThinkingConfigOption(thinkingLevel, thinkingValues),
        ]),
        getEvents: () => Stream.fromQueue(events),
        setModel: (model) =>
          Effect.sync(() => {
            state.selectedModels.push(model);
            currentModel = model;
          }),
        setConfigOption: (id, value) =>
          Effect.sync(() => {
            if (id === "thinking_level" && typeof value === "string") {
              state.thinkingUpdates.push(value);
              thinkingLevel = value;
            }
            return { configOptions: [] };
          }),
        prompt: (request) =>
          Effect.gen(function* () {
            const currentPromptIndex = promptIndex;
            promptIndex += 1;
            state.prompts.push(request);
            state.promptModels.push(currentModel);
            state.promptThinkingLevels.push(thinkingLevel);
            if (options.onPrompt !== undefined) {
              yield* options.onPrompt(currentPromptIndex);
            }
            const output = outputs.shift() ?? '{"suggestion":""}';
            yield* sessionUpdate({
              sessionId: SESSION_ID,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: output },
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

  const samplerScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(samplerScope, exit));
  const samplePromptSuggestion = yield* makeAntigravityPromptSuggestionSampler({
    profileDirectory,
    defaultModel: Effect.succeed("gemini-instance-default"),
    makeRuntime,
    withProcess,
  }).pipe(Effect.provideService(Scope.Scope, samplerScope));

  const assertCleaned = Effect.gen(function* () {
    yield* Scope.close(samplerScope, Exit.void);
    expect(state.closed).toEqual(state.workspaces);
    for (const workspace of state.workspaces) {
      expect(yield* fs.exists(workspace)).toBe(false);
    }
    expect(yield* fs.exists(`${sessionBase}.db`)).toBe(false);
    expect(yield* fs.exists(`${sessionBase}.db-wal`)).toBe(false);
    expect(yield* fs.exists(`${sessionBase}.meta`)).toBe(false);
    expect(yield* fs.exists(brainDirectory)).toBe(false);
    expect(yield* fs.readFileString(path.join(conversations, "user-session.db"))).toBe(
      "keep native history",
    );
  });

  return {
    state,
    samplePromptSuggestion,
    awaitNextClose: () => Deferred.await(closedSignal),
    assertCleaned,
  };
});

describe("antigravityPromptSuggestion.cn helpers", () => {
  it("resolves preferred models with Hydrogen -> 3.8 Flash -> current model fallback", () => {
    expect(ANTIGRAVITY_PROMPT_SUGGESTION_MODEL_PREFERENCE).toEqual([
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
    ]);

    expect(
      selectAntigravityPromptSuggestionModel(
        [
          makeModelConfigOption("gemini-4-argon", [
            "gemini-4-argon",
            "gemini-3.8-flash",
            "gemini-4-hydrogen",
          ]),
        ],
        "gemini-4-argon",
      ),
    ).toBe("gemini-4-hydrogen");

    expect(
      selectAntigravityPromptSuggestionModel(
        [makeModelConfigOption("gemini-4-neon", ["gemini-4-neon", "gemini-3.8-flash"])],
        "gemini-4-neon",
      ),
    ).toBe("gemini-3.8-flash");

    expect(
      selectAntigravityPromptSuggestionModel(
        [makeModelConfigOption("gemini-4-neon", ["gemini-4-neon", "gemini-4-argon"])],
        "gemini-4-argon",
      ),
    ).toBe("gemini-4-argon");

    expect(selectAntigravityPromptSuggestionModel(undefined, ANTIGRAVITY_DEFAULT_MODEL)).toBe(
      ANTIGRAVITY_DEFAULT_MODEL,
    );
  });

  it("picks the lowest available thinking level unless already at lowest", () => {
    expect(
      selectLowestAntigravityThinkingLevel([
        makeThinkingConfigOption("high", ["high", "low", "minimal", "off"]),
      ]),
    ).toEqual({ id: "thinking_level", value: "off" });

    expect(
      selectLowestAntigravityThinkingLevel([
        makeThinkingConfigOption("high", ["minimal", "low", "high"]),
      ]),
    ).toEqual({ id: "thinking_level", value: "minimal" });

    expect(
      selectLowestAntigravityThinkingLevel([makeThinkingConfigOption("low", ["low", "high"])]),
    ).toBeUndefined();
  });

  it("builds language-following prompt and preserves the tail of long transcripts", () => {
    const longReply = `${"x".repeat(4_500)}是否要顺便补测试？`;
    const prompt = buildAntigravityPromptSuggestionPrompt([
      { role: "user", text: "帮我修复解析器里的边界问题。" },
      { role: "assistant", text: longReply },
    ]);

    expect(prompt).toContain("Match the language of the latest user message");
    expect(prompt).toContain("<= 25 Chinese characters or under 20 English words");
    expect(prompt).toContain("Never write internal system or delegated-task notifications.");
    expect(prompt).toContain("帮我修复解析器里的边界问题。");
    expect(prompt).toContain("[Earlier content truncated]");
    expect(prompt).toContain("是否要顺便补测试？");
  });

  it("sanitizes empty, overlong, delegated-task, and multiline suggestions", () => {
    expect(sanitizeAntigravityPromptSuggestion("   ")).toBeNull();
    expect(sanitizeAntigravityPromptSuggestion("a".repeat(201))).toBeNull();
    expect(
      sanitizeAntigravityPromptSuggestion("Delegated task finished with 2 findings"),
    ).toBeNull();
    expect(sanitizeAntigravityPromptSuggestion("  补充一下\n  单元测试  ")).toBe(
      "补充一下 单元测试",
    );
  });
});

it.layer(NodeServices.layer)("antigravityPromptSuggestion.cn sampler", (it) => {
  it.effect(
    "switches to gemini-4-hydrogen at lowest thinking level and cleans up session files",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeSamplerFixture({
          outputs: ['```json\n{"suggestion":"  补充 subtract 单元测试\\n"}\n```'],
          availableModels: ["gemini-4-argon", "gemini-3.8-flash", "gemini-4-hydrogen"],
          initialModel: "gemini-4-argon",
          thinkingValues: ["minimal", "low", "high"],
          initialThinking: "high",
        });

        const suggestion = yield* fixture.samplePromptSuggestion({
          modelSelection: {
            instanceId,
            model: "gemini-4-argon",
            options: [{ id: "thinking_level", value: "high" }],
          },
          messages: [
            { role: "user", text: "加上 subtract 函数。" },
            { role: "assistant", text: "已经在 math.ts 里加上 subtract。" },
          ],
        });

        expect(suggestion).toBe("补充 subtract 单元测试");
        expect(fixture.state.selectedModels).toEqual(["gemini-4-hydrogen"]);
        expect(fixture.state.promptModels).toEqual(["gemini-4-hydrogen"]);
        expect(fixture.state.thinkingUpdates).toEqual(["minimal"]);
        expect(fixture.state.promptThinkingLevels).toEqual(["minimal"]);
        yield* fixture.assertCleaned;
      }),
  );

  it.effect("falls back to gemini-3.8-flash when Hydrogen is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* makeSamplerFixture({
        outputs: ['{"suggestion":"run unit tests"}'],
        availableModels: ["gemini-4-neon", "gemini-3.8-flash"],
        initialModel: "gemini-4-neon",
        thinkingValues: ["low", "high"],
        initialThinking: "high",
      });

      const suggestion = yield* fixture.samplePromptSuggestion({
        modelSelection: { instanceId, model: "gemini-4-neon" },
        messages: [
          { role: "user", text: "Fix the parser." },
          { role: "assistant", text: "Fixed the parser." },
        ],
      });

      expect(suggestion).toBe("run unit tests");
      expect(fixture.state.selectedModels).toEqual(["gemini-3.8-flash"]);
      expect(fixture.state.promptThinkingLevels).toEqual(["low"]);
      yield* fixture.assertCleaned;
    }),
  );

  it.effect(
    "falls back to the current thread model when neither Hydrogen nor 3.8 Flash is listed",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeSamplerFixture({
          outputs: ['{"suggestion":"open a PR"}'],
          availableModels: ["gemini-4-neon", "gemini-4-argon"],
          initialModel: "gemini-4-neon",
          thinkingValues: ["low", "high"],
          initialThinking: "high",
        });

        const suggestion = yield* fixture.samplePromptSuggestion({
          modelSelection: { instanceId, model: "gemini-4-argon" },
          messages: [
            { role: "user", text: "Fix the bug." },
            { role: "assistant", text: "Fixed it." },
          ],
        });

        expect(suggestion).toBe("open a PR");
        expect(fixture.state.selectedModels).toEqual(["gemini-4-argon"]);
        expect(fixture.state.promptThinkingLevels).toEqual(["low"]);
        yield* fixture.assertCleaned;
      }),
  );

  it.effect.each([
    { name: "empty", output: '{"suggestion":""}', expected: null },
    {
      name: "delegated-task imitation",
      output: '{"suggestion":"Delegated task completed"}',
      expected: null,
    },
    {
      name: "overlong",
      output: JSON.stringify({ suggestion: "x".repeat(201) }),
      expected: null,
    },
    {
      name: "code-fenced json",
      output: 'Here is the result:\n```json\n{"suggestion":"run the\\n  test suite"}\n```',
      expected: "run the test suite",
    },
  ])("filters $name output from sampler", ({ output, expected }) =>
    Effect.gen(function* () {
      const fixture = yield* makeSamplerFixture({
        outputs: [output],
        availableModels: ["gemini-4-hydrogen"],
      });

      const suggestion = yield* fixture.samplePromptSuggestion({
        modelSelection: { instanceId, model: "gemini-4-hydrogen" },
        messages: [
          { role: "user", text: "Update tests." },
          { role: "assistant", text: "Updated tests." },
        ],
      });

      expect(suggestion).toBe(expected);
      yield* fixture.assertCleaned;
    }),
  );

  it.effect(
    "reuses one warm runtime across consecutive samples, retires on idle timeout, and rebuilds on demand",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeSamplerFixture({
          outputs: [
            '{"suggestion":"first suggestion"}',
            '{"suggestion":"second suggestion"}',
            '{"suggestion":"after idle rebuild"}',
          ],
          availableModels: ["gemini-4-hydrogen"],
        });

        const first = yield* fixture.samplePromptSuggestion({
          modelSelection: { instanceId, model: "gemini-4-hydrogen" },
          messages: [{ role: "user", text: "Turn 1" }],
        });
        const second = yield* fixture.samplePromptSuggestion({
          modelSelection: { instanceId, model: "gemini-4-hydrogen" },
          messages: [{ role: "user", text: "Turn 2" }],
        });

        expect(first).toBe("first suggestion");
        expect(second).toBe("second suggestion");
        expect(fixture.state.workspaces).toHaveLength(1);
        expect(fixture.state.closed).toHaveLength(0);
        expect(fixture.state.prompts).toHaveLength(2);

        yield* TestClock.adjust("4 minutes");
        expect(fixture.state.closed).toHaveLength(0);

        const waitClose = fixture.awaitNextClose();
        yield* TestClock.adjust("1 minute");
        yield* waitClose;
        expect(fixture.state.closed).toHaveLength(1);

        const third = yield* fixture.samplePromptSuggestion({
          modelSelection: { instanceId, model: "gemini-4-hydrogen" },
          messages: [{ role: "user", text: "Turn 3" }],
        });
        expect(third).toBe("after idle rebuild");
        expect(fixture.state.workspaces).toHaveLength(2);
        expect(fixture.state.prompts).toHaveLength(3);
        yield* fixture.assertCleaned;
      }),
  );

  it.effect("discards broken warm runtime on error and creates a fresh runtime next sample", () =>
    Effect.gen(function* () {
      const fixture = yield* makeSamplerFixture({
        outputs: ['{"suggestion":"recovered"}'],
        availableModels: ["gemini-4-hydrogen"],
        onPrompt: (index) =>
          index === 0
            ? Effect.fail(
                new EffectAcpErrors.AcpTransportError({
                  operation: "call-rpc",
                  method: "session/prompt",
                  detail: "simulated crash",
                  cause: undefined,
                }),
              )
            : Effect.void,
      });

      const exit = yield* fixture
        .samplePromptSuggestion({
          modelSelection: { instanceId, model: "gemini-4-hydrogen" },
          messages: [{ role: "user", text: "Turn 1" }],
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fixture.state.workspaces).toHaveLength(1);
      expect(fixture.state.closed).toHaveLength(1);

      const recovered = yield* fixture.samplePromptSuggestion({
        modelSelection: { instanceId, model: "gemini-4-hydrogen" },
        messages: [{ role: "user", text: "Turn 2" }],
      });
      expect(recovered).toBe("recovered");
      expect(fixture.state.workspaces).toHaveLength(2);
      yield* fixture.assertCleaned;
    }),
  );
});
