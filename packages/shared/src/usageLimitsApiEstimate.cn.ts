import {
  isProviderAvailable,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageBucket,
  UsageDay,
  type UsageProviderKind,
  type UsageSummaryInput,
  type UsageWindowModelScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { LimitPresentations } from "./usageLimits.ts";

const MINUTE_MS = 60_000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * MINUTE_MS;

export const WEEKLY_API_ESTIMATE_MIN_USED_PERCENT = 10;
const MONTHLY_FROM_WEEKLY_FACTOR = 30 / 7;

/** 显式映射所有内置 driver 到用量 bucket 的 provider；无用量来源的返回 null。 */
const DRIVER_TO_USAGE_PROVIDER: Readonly<Record<string, UsageProviderKind | null>> = {
  codex: "codex",
  claudeAgent: "claude",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
  fx: null,
  kiro: null,
  acpRegistry: null,
};

/** 账号全模型周窗口（即使远端是未带 modelScope 的旧版本也视为全模型）。 */
const ACCOUNT_WIDE_WEEKLY_WINDOW_IDS: Readonly<Record<string, ReadonlySet<string>>> = {
  codex: new Set(["primary", "secondary"]),
  claudeAgent: new Set(["seven_day"]),
  grok: new Set(["subscription"]),
  muse: new Set(["weekly"]),
};

export function driverUsageProvider(driver: ProviderDriverKind | string): UsageProviderKind | null {
  return Object.hasOwn(DRIVER_TO_USAGE_PROVIDER, driver)
    ? (DRIVER_TO_USAGE_PROVIDER[driver] ?? null)
    : null;
}

function normalizeScopeModelId(model: string): string {
  const trimmed = model.trim();
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base.replace(/\[1m\]$/i, "").toLowerCase();
}

function matchModelScope(scope: UsageWindowModelScope, model: string): boolean {
  if (scope.kind === "all") return true;
  const normalized = normalizeScopeModelId(model);
  if (!scope.includePrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()))) {
    return false;
  }
  if (
    scope.includeSubstrings &&
    !scope.includeSubstrings.some((part) => normalized.includes(part.toLowerCase()))
  ) {
    return false;
  }
  if (
    scope.excludeSubstrings &&
    scope.excludeSubstrings.some((part) => normalized.includes(part.toLowerCase()))
  ) {
    return false;
  }
  return true;
}

/** 返回窗口对应的模型过滤函数；范围不明且非账号全模型窗口返回 null。 */
export function resolveWeeklyWindowModelMatcher(
  driver: ProviderDriverKind | string,
  window: Pick<ServerProviderUsageWindow, "id" | "modelIds" | "modelScope">,
): ((model: string) => boolean) | null {
  if (window.modelIds !== undefined) {
    if (window.modelIds.length === 0) return null;
    const exact = new Set(window.modelIds);
    const normalized = new Set(window.modelIds.map(normalizeScopeModelId));
    return (model: string) => exact.has(model) || normalized.has(normalizeScopeModelId(model));
  }
  if (window.modelScope !== undefined) {
    const scope = window.modelScope;
    return (model: string) => matchModelScope(scope, model);
  }
  if (ACCOUNT_WIDE_WEEKLY_WINDOW_IDS[driver]?.has(window.id)) {
    return () => true;
  }
  return null;
}

function nativeAccountIdentity(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  const workspaceId = provider.auth.workspaceId?.trim();
  if (email) return workspaceId ? `email:${email}:${workspaceId}` : `email:${email}`;
  const fingerprint = provider.usageLimits?.credentialFingerprint?.trim();
  if (fingerprint) return workspaceId ? `fp:${fingerprint}:${workspaceId}` : `fp:${fingerprint}`;
  return null;
}

export function countDistinctDriverAccounts(
  driver: ServerProvider["driver"],
  poolAccountsCount: number,
  presentations?: LimitPresentations,
): number {
  let maxCount = poolAccountsCount;
  if (!presentations) return maxCount;
  const distinctIdentities = new Set<string>();
  let unidentifiableCount = 0;
  for (const [environmentId, presentation] of presentations) {
    const activeProviders = (presentation.serverConfig?.providers ?? []).filter(
      (provider) =>
        provider.driver === driver &&
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider) &&
        provider.auth.status !== "unauthenticated",
    );
    let envActiveCount = 0;
    for (const provider of activeProviders) {
      envActiveCount += 1;
      const identity = nativeAccountIdentity(provider);
      if (identity !== null) distinctIdentities.add(identity);
      else unidentifiableCount += 1;
    }
    if (envActiveCount > maxCount) maxCount = envActiveCount;
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (account.driver !== driver) continue;
        const email = account.email?.trim().toLowerCase();
        const fingerprint = account.usageLimits.credentialFingerprint?.trim();
        const workspaceId = account.workspaceId?.trim();
        if (email) {
          distinctIdentities.add(workspaceId ? `email:${email}:${workspaceId}` : `email:${email}`);
        } else if (fingerprint) {
          distinctIdentities.add(
            workspaceId ? `fp:${fingerprint}:${workspaceId}` : `fp:${fingerprint}`,
          );
        } else {
          distinctIdentities.add(`hub:${environmentId}:${source.id}:${account.id}`);
        }
      }
    }
  }
  return Math.max(
    maxCount,
    distinctIdentities.size + (unidentifiableCount > 1 ? unidentifiableCount : 0),
  );
}

export interface WeeklyWindowBounds {
  readonly windowStartMs: number;
  readonly resetsAtMs: number;
}

export function weeklyWindowBounds(
  window: Pick<ServerProviderUsageWindow, "kind" | "resetsAt" | "windowDurationMins">,
  now: number,
): WeeklyWindowBounds | null {
  if (window.kind !== "weekly") return null;
  if (
    window.resetsAt === undefined ||
    window.windowDurationMins === undefined ||
    !Number.isFinite(window.windowDurationMins) ||
    window.windowDurationMins <= 0
  ) {
    return null;
  }
  const resetsAtMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAtMs)) return null;
  const windowStartMs = resetsAtMs - window.windowDurationMins * MINUTE_MS;
  if (!Number.isFinite(windowStartMs) || now <= windowStartMs) return null;
  return { windowStartMs, resetsAtMs };
}

export function resolveViewerTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return "UTC";
  }
}

export function formatCalendarDayInZone(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  }
}

export function addCalendarDays(day: string, deltaDays: number): string {
  const [year = 0, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const ms = Date.UTC(year, month - 1, dayOfMonth + deltaDays);
  return DateTime.formatIsoDateUtc(DateTime.makeUnsafe(ms));
}

export function localDayStartMs(day: string, timeZone: string): number {
  const [year = 0, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const zone = DateTime.zoneMakeNamed(timeZone);
  if (Option.isNone(zone)) {
    return Date.UTC(year, month - 1, dayOfMonth);
  }
  const zoned = DateTime.makeZoned(
    { year, month, day: dayOfMonth, hour: 0, minute: 0, second: 0 },
    { timeZone: zone.value, adjustForTimeZone: true, disambiguation: "earlier" },
  );
  return Option.match(zoned, {
    onSome: (dt) => DateTime.toEpochMillis(dt),
    onNone: () => Date.UTC(year, month - 1, dayOfMonth),
  });
}

export interface HourlySliceRange {
  readonly key: string;
  readonly sinceTimeMs: number;
  readonly untilTimeMs: number;
  readonly input: UsageSummaryInput;
}

export interface DailySliceRange {
  readonly sinceDay: string;
  readonly untilDay: string;
}

export interface WeeklyWindowUsagePlan {
  readonly dailyRange: DailySliceRange | null;
  readonly hourlyRanges: readonly HourlySliceRange[];
}

/**
 * 将「窗口起点 → 当前」拆分为零重叠的 [起点当天小时段] + [次日至今天粒度] 切片，
 * 以兼容服务端 hourly ≤24 小时上限且不改契约版本。
 */
export function planWeeklyWindowUsageSlices(
  windowStartMs: number,
  now: number,
  timeZone: string,
): WeeklyWindowUsagePlan {
  const startDay = formatCalendarDayInZone(windowStartMs, timeZone);
  const endDay = formatCalendarDayInZone(now, timeZone);
  const startDayMidnightMs = localDayStartMs(startDay, timeZone);
  const nextDay = addCalendarDays(startDay, 1);
  const nextDayMidnightMs = localDayStartMs(nextDay, timeZone);

  if (windowStartMs <= startDayMidnightMs) {
    return {
      dailyRange: { sinceDay: startDay, untilDay: endDay },
      hourlyRanges: [],
    };
  }

  const hourlyRanges: HourlySliceRange[] = [];
  // 25h DST 回退日若从 00:xx 开始可能超过 24h，按 24h 分块确保永不触发服务端报错。
  let cursor = windowStartMs;
  while (cursor < nextDayMidnightMs) {
    const chunkEnd = Math.min(nextDayMidnightMs, cursor + MAX_HOURLY_WINDOW_MS);
    const sinceTime = DateTime.formatIso(DateTime.makeUnsafe(cursor));
    const untilTime = DateTime.formatIso(DateTime.makeUnsafe(chunkEnd));
    const sinceDay = UsageDay.make(formatCalendarDayInZone(cursor, timeZone));
    const untilDay = UsageDay.make(
      formatCalendarDayInZone(Math.max(cursor, chunkEnd - 1), timeZone),
    );
    const input: UsageSummaryInput = {
      sinceDay,
      untilDay,
      timeZone,
      resolution: "hour",
      sinceTime,
      untilTime,
    };
    hourlyRanges.push({
      key: JSON.stringify(input),
      sinceTimeMs: cursor,
      untilTimeMs: chunkEnd,
      input,
    });
    cursor = chunkEnd;
  }

  return {
    dailyRange: startDay < endDay ? { sinceDay: nextDay, untilDay: endDay } : null,
    hourlyRanges,
  };
}

export type WeeklyApiEstimateResult =
  | {
      readonly status: "ready";
      readonly usageProvider: UsageProviderKind;
      readonly usedPercent: number;
      readonly windowCostUsd: number;
      readonly weeklyUsd: number;
      readonly monthlyUsd: number;
    }
  | {
      readonly status: "loading";
    }
  | {
      readonly status: "ineligible";
      readonly reason: "notWeekly" | "noUsageSource";
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "multiAccount"
        | "unknownScope"
        | "missingBounds"
        | "lowUsage"
        | "noLocalUsage";
    };

export interface WeeklyApiEstimateInput {
  readonly driver: ServerProvider["driver"];
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly timeZone: string;
  readonly accountCount: number;
  readonly dailyBuckets: readonly UsageBucket[];
  readonly hourlyBuckets: readonly UsageBucket[];
  readonly isLoading?: boolean;
}

export function evaluateWeeklyApiEstimate(input: WeeklyApiEstimateInput): WeeklyApiEstimateResult {
  if (input.window.kind !== "weekly") {
    return { status: "ineligible", reason: "notWeekly" };
  }
  const usageProvider = driverUsageProvider(input.driver);
  if (usageProvider === null) {
    return { status: "ineligible", reason: "noUsageSource" };
  }
  if (input.accountCount > 1) {
    return { status: "unavailable", reason: "multiAccount" };
  }
  const matcher = resolveWeeklyWindowModelMatcher(input.driver, input.window);
  if (matcher === null) {
    return { status: "unavailable", reason: "unknownScope" };
  }
  const bounds = weeklyWindowBounds(input.window, input.now);
  if (bounds === null) {
    return { status: "unavailable", reason: "missingBounds" };
  }
  if (input.window.usedPercent < WEEKLY_API_ESTIMATE_MIN_USED_PERCENT) {
    return { status: "unavailable", reason: "lowUsage" };
  }
  if (input.isLoading) {
    return { status: "loading" };
  }

  const plan = planWeeklyWindowUsageSlices(bounds.windowStartMs, input.now, input.timeZone);
  const startDay = formatCalendarDayInZone(bounds.windowStartMs, input.timeZone);
  const nextDayMidnightMs = localDayStartMs(addCalendarDays(startDay, 1), input.timeZone);

  let costUsd = 0;
  if (plan.dailyRange !== null) {
    for (const bucket of input.dailyBuckets) {
      if (bucket.provider !== usageProvider) continue;
      if (bucket.day < plan.dailyRange.sinceDay || bucket.day > plan.dailyRange.untilDay) continue;
      if (!matcher(bucket.model)) continue;
      costUsd += bucket.costUsd;
    }
  }
  for (const bucket of input.hourlyBuckets) {
    if (bucket.provider !== usageProvider) continue;
    if (!matcher(bucket.model)) continue;
    if (bucket.hourStart !== undefined) {
      const hourMs = Date.parse(bucket.hourStart);
      if (
        !Number.isFinite(hourMs) ||
        hourMs + 60 * MINUTE_MS <= bounds.windowStartMs ||
        hourMs >= nextDayMidnightMs
      ) {
        continue;
      }
    }
    costUsd += bucket.costUsd;
  }

  if (!(costUsd > 0) || !Number.isFinite(costUsd)) {
    return { status: "unavailable", reason: "noLocalUsage" };
  }

  const weeklyUsd = costUsd / (input.window.usedPercent / 100);
  const monthlyUsd = weeklyUsd * MONTHLY_FROM_WEEKLY_FACTOR;
  if (!Number.isFinite(weeklyUsd) || !Number.isFinite(monthlyUsd)) {
    return { status: "unavailable", reason: "noLocalUsage" };
  }

  return {
    status: "ready",
    usageProvider,
    usedPercent: input.window.usedPercent,
    windowCostUsd: costUsd,
    weeklyUsd,
    monthlyUsd,
  };
}

export function mergeDailyUsageQueries(
  plans: readonly WeeklyWindowUsagePlan[],
  timeZone: string,
): UsageSummaryInput | null {
  let sinceDay: string | null = null;
  let untilDay: string | null = null;
  for (const plan of plans) {
    if (plan.dailyRange === null) continue;
    if (sinceDay === null || plan.dailyRange.sinceDay < sinceDay) {
      sinceDay = plan.dailyRange.sinceDay;
    }
    if (untilDay === null || plan.dailyRange.untilDay > untilDay) {
      untilDay = plan.dailyRange.untilDay;
    }
  }
  if (sinceDay === null || untilDay === null) return null;
  return {
    sinceDay: UsageDay.make(sinceDay),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution: "day",
  };
}
