import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import type { PromptAdvisorInspection } from "./promptAdvisor.cn.ts";
import { IDLE_INSPECTION, stubPromptAdvisorRuntime } from "./promptAdvisor.testkit.cn.ts";
import {
  DEFAULT_PROMPT_ADVISOR_CONFIG,
  DEFAULT_SESSION_SPRITE_CONFIG,
  decodePromptAdvisorConfig,
  loadPromptAdvisorConfig,
  type PromptAdvisorConfig,
  resolveRoleTarget,
  savePromptAdvisorConfig,
  targetSignature,
} from "./promptAdvisorConfig.cn.ts";
import {
  describePromptAdvisors,
  registerPromptAdvisor,
  resolvePromptAdvisor,
  resolvePromptRefiner,
  retainPromptAdvisorSlots,
} from "./promptAdvisorRegistry.cn.ts";

const withRuntimes = (config: Partial<PromptAdvisorConfig["advisor"]>): PromptAdvisorConfig => ({
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  advisor: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor, ...config },
});

const split = (
  advisor: Partial<PromptAdvisorConfig["advisor"]["runtime"]>,
  refiner: Partial<PromptAdvisorConfig["advisor"]["runtime"]>,
): PromptAdvisorConfig => ({
  ...DEFAULT_PROMPT_ADVISOR_CONFIG,
  advisor: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor,
    runtime: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.advisor.runtime, ...advisor },
  },
  refiner: {
    ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner,
    followAdvisorRuntime: false,
    runtime: { ...DEFAULT_PROMPT_ADVISOR_CONFIG.refiner.runtime, ...refiner },
  },
});

describe("提示词顾问配置：结构与目标解析", () => {
  it("默认配置通过校验，往返不变", () => {
    expect(decodePromptAdvisorConfig(DEFAULT_PROMPT_ADVISOR_CONFIG)).toEqual(
      Option.some(DEFAULT_PROMPT_ADVISOR_CONFIG),
    );
  });

  it("缺字段、错类型、空标识、超长文本、错版本都不通过", () => {
    const base = DEFAULT_PROMPT_ADVISOR_CONFIG;
    for (const candidate of [
      null,
      "x",
      {},
      { ...base, version: 2 },
      { ...base, advisor: { ...base.advisor, lenses: { grilling: true } } },
      { ...base, advisor: { ...base.advisor, runtime: { ...base.advisor.runtime, model: "" } } },
      { ...base, advisor: { ...base.advisor, runtime: { ...base.advisor.runtime, model: 3 } } },
      { ...base, advisor: { ...base.advisor, customAppendix: "x".repeat(2_001) } },
      { ...base, advisor: { ...base.advisor, promptOverride: "x".repeat(8_001) } },
      {
        ...base,
        refiner: { ...base.refiner, modeOverrides: { ...base.refiner.modeOverrides, bold: 1 } },
      },
      { ...base, sprite: null },
      { ...base, sprite: {} },
      { ...base, sprite: { ...base.sprite, mode: "auto" } },
      { ...base, sprite: { ...base.sprite, scanIntervalMinutes: 1 } },
      { ...base, sprite: { ...base.sprite, scanIntervalMinutes: 61 } },
      { ...base, sprite: { ...base.sprite, idleMinutes: 0 } },
      { ...base, sprite: { ...base.sprite, maxPerThreadPerHumanTurn: 3 } },
      { ...base, sprite: { ...base.sprite, maxGlobalPerHour: 13 } },
      { ...base, sprite: { ...base.sprite, quietStartHour: 25 } },
      { ...base, sprite: { ...base.sprite, quietEndHour: -1 } },
      { ...base, sprite: { ...base.sprite, blockedTitleKeywords: [""] } },
      { ...base, sprite: { ...base.sprite, blockedTitleKeywords: Array(65).fill("kw") } },
    ]) {
      expect(Option.isNone(decodePromptAdvisorConfig(candidate)), JSON.stringify(candidate)).toBe(
        true,
      );
    }
  });

  it("旧配置缺少 sprite 字段时向后兼容补全默认值", () => {
    const { sprite: _omitted, ...legacy } = DEFAULT_PROMPT_ADVISOR_CONFIG;
    expect(decodePromptAdvisorConfig(legacy)).toEqual(
      Option.some({ ...legacy, sprite: DEFAULT_SESSION_SPRITE_CONFIG }),
    );
  });

  it("跟随时优化沿用顾问的目标，不跟随时用自己的", () => {
    const follow = withRuntimes({
      runtime: { instanceId: "antigravity", model: "gemini-4-neon", thinking: "low" },
    });
    expect(resolveRoleTarget(follow, "refiner")).toEqual(follow.advisor.runtime);
    const apart = split({ model: "gemini-4-neon" }, { model: "gemini-4-carbon" });
    expect(resolveRoleTarget(apart, "advisor").model).toBe("gemini-4-neon");
    expect(resolveRoleTarget(apart, "refiner").model).toBe("gemini-4-carbon");
  });

  it("签名只看请求的模型与思考档，空值与自动是同一个", () => {
    expect(targetSignature({ model: null, thinking: null })).toBe(
      targetSignature({ model: null, thinking: null }),
    );
    expect(targetSignature({ model: "a", thinking: null })).not.toBe(
      targetSignature({ model: null, thinking: "a" }),
    );
    expect(targetSignature({ model: "a", thinking: "b" })).not.toBe(
      targetSignature({ model: "a", thinking: "c" }),
    );
  });
});

describe("提示词顾问配置：落盘", () => {
  it.layer(NodeServices.layer)("文件", (it) => {
    const makeFile = Effect.fn("makeConfigFile")(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-advisor-config-" });
      return { fs, file: path.join(directory, "cn-prompt-advisor.json") };
    });

    it.effect("文件不存在用默认，不创建文件", () =>
      Effect.gen(function* () {
        const { fs, file } = yield* makeFile();
        expect(yield* loadPromptAdvisorConfig(file)).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("损坏或不完整的文件回退默认，且原文件一字不动", () =>
      Effect.gen(function* () {
        const { fs, file } = yield* makeFile();
        for (const text of ["{ half", "", '{"version":1}', "null"]) {
          yield* fs.writeFileString(file, text);
          expect(yield* loadPromptAdvisorConfig(file)).toEqual(DEFAULT_PROMPT_ADVISOR_CONFIG);
          expect(yield* fs.readFileString(file)).toBe(text);
        }
      }).pipe(Effect.scoped),
    );

    it.effect("保存后原子换名：读回一致，不留临时文件，覆盖旧内容", () =>
      Effect.gen(function* () {
        const { fs, file } = yield* makeFile();
        const first = withRuntimes({ customAppendix: "第一版" });
        const second = withRuntimes({ customAppendix: "第二版" });
        yield* savePromptAdvisorConfig(file, first);
        expect(yield* loadPromptAdvisorConfig(file)).toEqual(first);
        yield* savePromptAdvisorConfig(file, second);
        expect(yield* loadPromptAdvisorConfig(file)).toEqual(second);
        expect(yield* fs.exists(`${file}.tmp`)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("目录不存在时保存失败，不会假装成功", () =>
      Effect.gen(function* () {
        const { file } = yield* makeFile();
        const exit = yield* Effect.exit(
          savePromptAdvisorConfig(`${file}-missing/dir/config.json`, DEFAULT_PROMPT_ADVISOR_CONFIG),
        );
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.scoped),
    );
  });
});

const inspection = (patch: Partial<PromptAdvisorInspection>): PromptAdvisorInspection => ({
  ...IDLE_INSPECTION,
  ...patch,
});

const liveSlot = (model: string, thinking: string, uses = 1) => ({
  signature: targetSignature({ model, thinking }),
  warm: true,
  uses,
  live: {
    activeModel: model,
    activeThinking: thinking,
    availableModels: [model, "gemini-4-hydrogen"],
    availableThinking: [thinking, "high"],
  },
});

describe("提示词顾问配置：实例解析与状态", () => {
  it.effect("默认优先 antigravity；点名实例可用就用它，不可用就回退自动优选", () =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor("antigravity_2", stubPromptAdvisorRuntime());
      yield* registerPromptAdvisor("antigravity", stubPromptAdvisorRuntime());
      yield* registerPromptAdvisor(
        "down",
        stubPromptAdvisorRuntime({ available: Effect.succeed(false) }),
      );
      const statusOf = (config: PromptAdvisorConfig) => describePromptAdvisors(config);
      expect((yield* statusOf(DEFAULT_PROMPT_ADVISOR_CONFIG)).advisor.resolvedInstanceId).toBe(
        "antigravity",
      );
      const named = split({ instanceId: "antigravity_2" }, { instanceId: "antigravity" });
      const status = yield* statusOf(named);
      expect(status.advisor.resolvedInstanceId).toBe("antigravity_2");
      expect(status.refiner.resolvedInstanceId).toBe("antigravity");
      const unavailable = yield* statusOf(split({ instanceId: "down" }, { instanceId: "missing" }));
      expect(unavailable.advisor).toMatchObject({
        requestedInstanceId: "down",
        resolvedInstanceId: "antigravity",
      });
      expect(unavailable.refiner).toMatchObject({
        requestedInstanceId: "missing",
        resolvedInstanceId: "antigravity",
      });
      expect(unavailable.instances).toEqual([
        { instanceId: "antigravity_2", available: true },
        { instanceId: "antigravity", available: true },
        { instanceId: "down", available: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("没有可用实例时角色都是 unavailable，实例解析为空", () =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor(
        "down",
        stubPromptAdvisorRuntime({ available: Effect.succeed(false) }),
      );
      const status = yield* describePromptAdvisors(DEFAULT_PROMPT_ADVISOR_CONFIG);
      expect(status.advisor.state).toBe("unavailable");
      expect(status.refiner.state).toBe("unavailable");
      expect(Option.isNone(yield* resolvePromptAdvisor)).toBe(true);
      expect(Option.isNone(yield* resolvePromptRefiner)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("冷态给预设列表，热态给实测值，同配时标记共用温槽", () =>
    Effect.gen(function* () {
      let inspected = 0;
      let started = 0;
      yield* registerPromptAdvisor(
        "antigravity",
        stubPromptAdvisorRuntime({
          sample: () => Effect.sync(() => ((started += 1), null)),
          runPrompt: () => Effect.sync(() => ((started += 1), "{}")),
          inspect: Effect.sync(() => ((inspected += 1), IDLE_INSPECTION)),
        }),
      );
      const cold = yield* describePromptAdvisors(DEFAULT_PROMPT_ADVISOR_CONFIG);
      expect(cold.advisor).toMatchObject({
        state: "idle",
        modelSource: "preset",
        activeModel: null,
        uses: 0,
        maxUses: 20,
        sharesSlot: true,
      });
      expect(cold.advisor.availableModels).toContain("gemini-4-neon");
      expect(cold.advisor.availableModels).toContain("gemini-3.8-flash");
      expect(inspected).toBe(2);
      expect(started).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("热态按各自签名取实测值与活动记录，异配时不共用", () =>
    Effect.gen(function* () {
      yield* registerPromptAdvisor(
        "antigravity",
        stubPromptAdvisorRuntime({
          inspect: Effect.succeed(
            inspection({
              slots: [liveSlot("gemini-4-neon", "low", 5), liveSlot("gemini-4-carbon", "high", 2)],
              activity: {
                advisor: { lastSampleAt: 1_000, lastDurationMs: 800, lastError: null },
                refiner: { lastSampleAt: 2_000, lastDurationMs: 3_000, lastError: "timed out" },
              },
            }),
          ),
        }),
      );
      const status = yield* describePromptAdvisors(
        split(
          { model: "gemini-4-neon", thinking: "low" },
          { model: "gemini-4-carbon", thinking: "high" },
        ),
      );
      expect(status.advisor).toMatchObject({
        state: "warm",
        modelSource: "live",
        activeModel: "gemini-4-neon",
        uses: 5,
        lastDurationMs: 800,
        lastError: null,
        sharesSlot: false,
      });
      expect(status.refiner).toMatchObject({
        state: "warm",
        activeModel: "gemini-4-carbon",
        uses: 2,
        lastDurationMs: 3_000,
        lastError: "timed out",
        sharesSlot: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("保留集：每个实例只保留指向它的角色签名", () =>
    Effect.gen(function* () {
      const kept: Record<string, Array<ReadonlyArray<string>>> = { a: [], b: [] };
      const track = (id: "a" | "b") =>
        stubPromptAdvisorRuntime({
          retain: (keep) => Effect.sync(() => void kept[id]?.push([...keep].toSorted())),
        });
      yield* registerPromptAdvisor("antigravity", track("a"));
      yield* registerPromptAdvisor("other", track("b"));
      const neon = targetSignature({ model: "gemini-4-neon", thinking: null });
      const carbon = targetSignature({ model: "gemini-4-carbon", thinking: null });

      yield* retainPromptAdvisorSlots(
        split(
          { instanceId: "antigravity", model: "gemini-4-neon" },
          { instanceId: "other", model: "gemini-4-carbon" },
        ),
      );
      expect(kept).toEqual({ a: [[neon]], b: [[carbon]] });

      kept.a = [];
      kept.b = [];
      yield* retainPromptAdvisorSlots(
        withRuntimes({ runtime: { instanceId: null, model: "gemini-4-neon", thinking: null } }),
      );
      expect(kept).toEqual({ a: [[neon]], b: [[]] });

      kept.a = [];
      kept.b = [];
      yield* retainPromptAdvisorSlots(
        split({ model: "gemini-4-neon" }, { model: "gemini-4-carbon" }),
      );
      expect(kept.a).toEqual([[carbon, neon].toSorted()]);
    }).pipe(Effect.scoped),
  );
});
