import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageBucket,
  UsageDay,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { LimitPresentations } from "./usageLimits.ts";
import {
  countDistinctDriverAccounts,
  driverUsageProvider,
  evaluateWeeklyApiEstimate,
  mergeDailyUsageQueries,
  planWeeklyWindowUsageSlices,
} from "./usageLimitsApiEstimate.cn.ts";

function makeBucket(
  overrides: Partial<UsageBucket> & {
    readonly day: string;
    readonly provider: UsageProviderKind;
    readonly model: string;
    readonly costUsd: number;
  },
): UsageBucket {
  return {
    totals: {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
    },
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function makeProvider(
  instanceId: string,
  driver: string,
  options: {
    readonly fingerprint?: string;
    readonly email?: string;
    readonly enabled?: boolean;
    readonly unavailable?: { readonly reason: "unsupported" | "probeFailed" };
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: options.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
      ...(options.email ? { email: options.email } : {}),
    },
    checkedAt: "2026-11-24T06:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-24T06:00:00.000Z",
      windows: [],
      ...(options.fingerprint ? { credentialFingerprint: options.fingerprint } : {}),
      ...(options.unavailable ? { unavailable: options.unavailable } : {}),
    },
  };
}

describe("usageLimitsApiEstimate", () => {
  const timeZone = "Asia/Shanghai";

  it("maps every built-in driver explicitly", () => {
    expect(driverUsageProvider("claudeAgent")).toBe("claude");
    expect(driverUsageProvider("codex")).toBe("codex");
    expect(driverUsageProvider("grok")).toBe("grok");
    expect(driverUsageProvider("antigravity")).toBe("antigravity");
    expect(driverUsageProvider("cursor")).toBe("cursor");
    expect(driverUsageProvider("opencode")).toBe("opencode");
    expect(driverUsageProvider("pi")).toBe("pi");
    expect(driverUsageProvider("muse")).toBe("muse");
    expect(driverUsageProvider("fx")).toBeNull();
    expect(driverUsageProvider("kiro")).toBeNull();
    expect(driverUsageProvider("acpRegistry")).toBeNull();
    expect(driverUsageProvider("unknownDriver")).toBeNull();
  });

  it("matches the 11-24 Claude Max local hand-computed benchmark ($1432.22 @ 21% -> ~$6820/wk, ~$29229/mo)", () => {
    // 窗口起点: 2026-11-19T08:30+08:00 (2026-11-19T00:30Z)，终点 resetsAt: 2026-11-26T00:30Z
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    const window: ServerProviderUsageWindow = {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      modelScope: { kind: "all" },
      usedPercent: 21,
      resetsAt: "2026-11-26T00:30:00.000Z",
      windowDurationMins: 7 * 24 * 60,
    };
    const result = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("claudeAgent"),
      window,
      now,
      timeZone,
      accountCount: 1,
      hourlyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-19"),
          hourStart: "2026-11-19T00:30:00.000Z",
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 244.0,
        }),
      ],
      dailyBuckets: [
        // 起点当天 2026-11-19 的天粒度桶不应重复计入
        makeBucket({
          day: UsageDay.make("2026-11-19"),
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 9999.0,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-20"),
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 300.0,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-21"),
          provider: "claude",
          model: "claude-opus-5-5",
          costUsd: 478.0,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "claude",
          model: "claude-sonnet-5-5",
          costUsd: 410.22,
        }),
        // 其他 provider 不计入
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "codex",
          model: "gpt-6.1-sol",
          costUsd: 500.0,
        }),
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.usageProvider).toBe("claude");
    expect(result.windowCostUsd).toBeCloseTo(1432.22, 2);
    expect(Math.round(result.weeklyUsd)).toBe(6820);
    expect(Math.round(result.monthlyUsd)).toBe(29229);
  });

  it("matches the 11-24 Grok local hand-computed benchmark ($35.43 @ 81% -> ~$44/wk)", () => {
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    const window: ServerProviderUsageWindow = {
      id: "subscription",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 81,
      resetsAt: "2026-11-25T10:00:00.000Z",
      windowDurationMins: 7 * 24 * 60,
    };
    const result = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("grok"),
      window,
      now,
      timeZone,
      accountCount: 1,
      hourlyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-18"),
          hourStart: "2026-11-18T10:00:00.000Z",
          provider: "grok",
          model: "grok-4.6",
          costUsd: 10.43,
        }),
      ],
      dailyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-21"),
          provider: "grok",
          model: "grok-4.6",
          costUsd: 25.0,
        }),
      ],
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.usageProvider).toBe("grok");
    expect(result.windowCostUsd).toBeCloseTo(35.43, 2);
    expect(Math.round(result.weeklyUsd)).toBe(44);
    expect(Math.round(result.monthlyUsd)).toBe(187);
  });

  it("filters cost by modelScope for Claude Fable and Antigravity 3P/Gemini windows", () => {
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    const claudeFableWindow: ServerProviderUsageWindow = {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      modelScope: { kind: "patterns", includePrefixes: ["claude-fable-"] },
      usedPercent: 50,
      resetsAt: "2026-11-26T00:00:00.000Z",
      windowDurationMins: 7 * 24 * 60,
    };
    const claudeResult = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("claudeAgent"),
      window: claudeFableWindow,
      now,
      timeZone,
      accountCount: 1,
      hourlyBuckets: [],
      dailyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "claude",
          model: "claude-fable-5",
          costUsd: 100,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "claude",
          model: "claude-opus-5-5",
          costUsd: 400,
        }),
      ],
    });
    expect(claudeResult).toMatchObject({ status: "ready", windowCostUsd: 100, weeklyUsd: 200 });

    const ag3pWindow: ServerProviderUsageWindow = {
      id: "3p-weekly",
      kind: "weekly",
      label: "Claude & GPT (shared) · Weekly",
      modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
      usedPercent: 50,
      resetsAt: "2026-11-26T00:00:00.000Z",
      windowDurationMins: 7 * 24 * 60,
    };
    const ag3pResult = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("antigravity"),
      window: ag3pWindow,
      now,
      timeZone,
      accountCount: 1,
      hourlyBuckets: [],
      dailyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "claude-opus-5-5",
          costUsd: 40,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "gpt-oss-120b-medium",
          costUsd: 10,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "gemini-4-argon-high",
          costUsd: 300,
        }),
      ],
    });
    expect(ag3pResult).toMatchObject({ status: "ready", windowCostUsd: 50, weeklyUsd: 100 });

    const agGeminiWindow: ServerProviderUsageWindow = {
      id: "gemini-weekly",
      kind: "weekly",
      label: "Gemini · Weekly",
      modelScope: {
        kind: "patterns",
        includePrefixes: ["gemini-"],
        excludeSubstrings: ["argon", "carbon"],
      },
      usedPercent: 25,
      resetsAt: "2026-11-26T00:00:00.000Z",
      windowDurationMins: 7 * 24 * 60,
    };
    const agGeminiResult = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("antigravity"),
      window: agGeminiWindow,
      now,
      timeZone,
      accountCount: 1,
      hourlyBuckets: [],
      dailyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "gemini-3.8-flash-high",
          costUsd: 25,
        }),
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "gemini-4-argon-high",
          costUsd: 200,
        }),
      ],
    });
    expect(agGeminiResult).toMatchObject({ status: "ready", windowCostUsd: 25, weeklyUsd: 100 });
  });

  it("refuses to show numbers for multi-account antigravity", () => {
    const presentations: LimitPresentations = new Map([
      [
        EnvironmentId.make("local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              makeProvider("antigravity", "antigravity", { fingerprint: "google-a" }),
              makeProvider("antigravity_2", "antigravity", { fingerprint: "google-b" }),
            ],
          },
        },
      ],
    ]);
    const accountsCount = countDistinctDriverAccounts(
      ProviderDriverKind.make("antigravity"),
      2,
      presentations,
    );
    expect(accountsCount).toBe(2);

    const result = evaluateWeeklyApiEstimate({
      driver: ProviderDriverKind.make("antigravity"),
      window: {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
        usedPercent: 50,
        resetsAt: "2026-11-26T00:00:00.000Z",
        windowDurationMins: 7 * 24 * 60,
      },
      now: Date.parse("2026-11-24T14:00:00+08:00"),
      timeZone,
      accountCount: accountsCount,
      hourlyBuckets: [],
      dailyBuckets: [
        makeBucket({
          day: UsageDay.make("2026-11-22"),
          provider: "antigravity",
          model: "claude-opus-5-5",
          costUsd: 100,
        }),
      ],
    });
    expect(result).toEqual({ status: "unavailable", reason: "multiAccount" });
  });

  it("refuses to show numbers for windows with unknown scope", () => {
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    // OpenCode Go 周窗口（无 modelIds 且非全账号模型窗口）
    expect(
      evaluateWeeklyApiEstimate({
        driver: ProviderDriverKind.make("opencode"),
        window: {
          id: "go_weekly",
          kind: "weekly",
          label: "Go · Weekly",
          usedPercent: 45,
          resetsAt: "2026-11-26T00:00:00.000Z",
          windowDurationMins: 7 * 24 * 60,
        },
        now,
        timeZone,
        accountCount: 1,
        hourlyBuckets: [],
        dailyBuckets: [
          makeBucket({
            day: UsageDay.make("2026-11-22"),
            provider: "opencode",
            model: "kimi-k2.5",
            costUsd: 20,
          }),
        ],
      }),
    ).toEqual({ status: "unavailable", reason: "unknownScope" });

    // 未知 scoped 窗口
    expect(
      evaluateWeeklyApiEstimate({
        driver: ProviderDriverKind.make("claudeAgent"),
        window: {
          id: "seven_day_mystery",
          kind: "weekly",
          label: "Weekly · Mystery",
          usedPercent: 45,
          resetsAt: "2026-11-26T00:00:00.000Z",
          windowDurationMins: 7 * 24 * 60,
        },
        now,
        timeZone,
        accountCount: 1,
        hourlyBuckets: [],
        dailyBuckets: [
          makeBucket({
            day: UsageDay.make("2026-11-22"),
            provider: "claude",
            model: "claude-opus-5-5",
            costUsd: 20,
          }),
        ],
      }),
    ).toEqual({ status: "unavailable", reason: "unknownScope" });
  });

  it("refuses to show numbers when usedPercent < 10 or for 5-hour session windows", () => {
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    const buckets = [
      makeBucket({
        day: UsageDay.make("2026-11-22"),
        provider: "claude",
        model: "claude-opus-5-5",
        costUsd: 50,
      }),
    ];
    expect(
      evaluateWeeklyApiEstimate({
        driver: ProviderDriverKind.make("claudeAgent"),
        window: {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          modelScope: { kind: "all" },
          usedPercent: 9.9,
          resetsAt: "2026-11-30T14:00:00.000Z",
          windowDurationMins: 7 * 24 * 60,
        },
        now,
        timeZone,
        accountCount: 1,
        hourlyBuckets: [],
        dailyBuckets: buckets,
      }),
    ).toEqual({ status: "unavailable", reason: "lowUsage" });

    expect(
      evaluateWeeklyApiEstimate({
        driver: ProviderDriverKind.make("claudeAgent"),
        window: {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 60,
          resetsAt: "2026-11-24T10:00:00.000Z",
          windowDurationMins: 300,
        },
        now,
        timeZone,
        accountCount: 1,
        hourlyBuckets: [],
        dailyBuckets: buckets,
      }),
    ).toEqual({ status: "ineligible", reason: "notWeekly" });
  });

  it("plans hourly <=24h + daily slices without gaps or overlaps", () => {
    // 窗口起点: 2026-11-19T08:30:00+08:00 (2026-11-19T00:30:00.000Z)
    const startMs = Date.parse("2026-11-19T08:30:00+08:00");
    const now = Date.parse("2026-11-24T14:00:00+08:00");
    const plan = planWeeklyWindowUsageSlices(startMs, now, timeZone);
    expect(plan.dailyRange).toEqual({ sinceDay: "2026-11-20", untilDay: "2026-11-24" });
    expect(plan.hourlyRanges).toHaveLength(1);
    expect(plan.hourlyRanges[0]?.input).toEqual({
      sinceDay: UsageDay.make("2026-11-19"),
      untilDay: UsageDay.make("2026-11-19"),
      timeZone,
      resolution: "hour",
      sinceTime: "2026-11-19T00:30:00.000Z",
      untilTime: "2026-11-19T16:00:00.000Z",
    });

    // 整点零点起点不需要小时切片
    const midnightStart = Date.parse("2026-11-18T00:00:00+08:00");
    const midnightPlan = planWeeklyWindowUsageSlices(midnightStart, now, timeZone);
    expect(midnightPlan.hourlyRanges).toEqual([]);
    expect(midnightPlan.dailyRange).toEqual({ sinceDay: "2026-11-18", untilDay: "2026-11-24" });

    // 合并天粒度范围取最小起点日
    const mergedDaily = mergeDailyUsageQueries([plan, midnightPlan], timeZone);
    expect(mergedDaily).toEqual({
      sinceDay: UsageDay.make("2026-11-18"),
      untilDay: UsageDay.make("2026-11-24"),
      timeZone,
      resolution: "day",
    });
  });
});
