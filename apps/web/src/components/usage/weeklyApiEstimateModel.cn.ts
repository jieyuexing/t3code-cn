import {
  type EnvironmentId,
  type ServerProvider,
  type UsageBucket,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import {
  addCalendarDays,
  countDistinctDriverAccounts,
  driverUsageProvider,
  evaluateWeeklyApiEstimate,
  formatCalendarDayInZone,
  localDayStartMs,
  mergeDailyUsageQueries,
  planWeeklyWindowUsageSlices,
  resolveViewerTimeZone,
  resolveWeeklyWindowModelMatcher,
  WEEKLY_API_ESTIMATE_MIN_USED_PERCENT,
  weeklyWindowBounds,
  type WeeklyApiEstimateResult,
  type WeeklyWindowUsagePlan,
} from "@t3tools/shared/usageLimitsApiEstimate.cn";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";

export interface EligibleWeeklyWindow {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly window: LimitPoolWindow["members"][number]["window"];
  readonly accountCount: number;
  readonly plan: WeeklyWindowUsagePlan;
  readonly windowStartMs: number;
  readonly nextDayMidnightMs: number;
}

export interface WeeklyEstimateQueryBundle {
  readonly bundleKey: string;
  readonly timeZone: string;
  readonly dailyInput: UsageSummaryInput | null;
  readonly hourlyInputs: readonly UsageSummaryInput[];
  readonly eligibleWindows: readonly EligibleWeeklyWindow[];
}

export function windowEstimateKey(
  driver: ServerProvider["driver"],
  window: Pick<LimitPoolWindow, "kind" | "id">,
): string {
  return `${driver}\0${window.kind}\0${window.id}`;
}

export function buildWeeklyEstimateQueryBundle(
  presentations: LimitPresentations,
  now: number,
  timeZone = resolveViewerTimeZone(),
): WeeklyEstimateQueryBundle {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const eligibleWindows: EligibleWeeklyWindow[] = [];
  const hourlyMap = new Map<string, UsageSummaryInput>();

  for (const pool of pools) {
    const usageProvider = driverUsageProvider(pool.driver);
    if (usageProvider === null) continue;
    const accountCount = countDistinctDriverAccounts(
      pool.driver,
      pool.accounts.length,
      presentations,
    );
    if (accountCount > 1) continue;

    for (const poolWindow of pool.windows) {
      if (poolWindow.kind !== "weekly") continue;
      const memberWindow = poolWindow.members[0]?.window;
      if (!memberWindow) continue;
      if (resolveWeeklyWindowModelMatcher(pool.driver, memberWindow) === null) continue;
      const bounds = weeklyWindowBounds(memberWindow, now);
      if (bounds === null) continue;
      if (memberWindow.usedPercent < WEEKLY_API_ESTIMATE_MIN_USED_PERCENT) continue;

      const plan = planWeeklyWindowUsageSlices(bounds.windowStartMs, now, timeZone);
      for (const slice of plan.hourlyRanges) {
        if (!hourlyMap.has(slice.key)) hourlyMap.set(slice.key, slice.input);
      }
      const startDay = formatCalendarDayInZone(bounds.windowStartMs, timeZone);
      const nextDayMidnightMs = localDayStartMs(addCalendarDays(startDay, 1), timeZone);
      eligibleWindows.push({
        key: windowEstimateKey(pool.driver, poolWindow),
        driver: pool.driver,
        window: memberWindow,
        accountCount,
        plan,
        windowStartMs: bounds.windowStartMs,
        nextDayMidnightMs,
      });
    }
  }

  const dailyInput = mergeDailyUsageQueries(
    eligibleWindows.map((entry) => entry.plan),
    timeZone,
  );
  const hourlyInputs = [...hourlyMap.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, input]) => input);

  return {
    bundleKey: JSON.stringify({ dailyInput, hourlyInputs }),
    timeZone,
    dailyInput,
    hourlyInputs,
    eligibleWindows,
  };
}

function filterStatusesByEnvironment(
  statuses: readonly EnvironmentUsageStatus[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): readonly EnvironmentUsageStatus[] {
  return selectedEnvironmentIds === null
    ? statuses
    : statuses.filter((status) => selectedEnvironmentIds.has(status.environmentId));
}

function sliceStatusSummary(statuses: readonly EnvironmentUsageStatus[]): {
  readonly isLoading: boolean;
  readonly unavailable: boolean;
} {
  if (statuses.length === 0) return { isLoading: false, unavailable: true };
  const answeredCount = statuses.filter((status) => status.summary !== null).length;
  const stillReporting = statuses.filter(
    (status) => status.canReadDiagnostics && status.summary === null && status.error === null,
  ).length;
  const isLoading = answeredCount === 0 && stillReporting > 0;
  const unavailable = answeredCount === 0 && stillReporting === 0;
  return { isLoading, unavailable };
}

function deduplicateWindowBuckets(
  statuses: readonly EnvironmentUsageStatus[],
  keepBucket: (bucket: UsageBucket) => boolean,
): readonly UsageBucket[] {
  const merged = mergeAnsweredUsage(statuses, keepBucket);
  // mergeUsage 把选定环境的桶按来源归属去重后聚合在 merged.models / merged.daily，但未同时保留 (day, model)。
  // 这里用单行合成桶把已去重总花费无损转回 evaluateWeeklyApiEstimate。
  return merged.models.map((model) => ({
    day: UsageDay.make("2026-01-01"),
    provider: model.provider,
    model: model.model,
    totals: model.tokens,
    costUsd: model.costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced" as const,
    records: model.records,
    unpricedRecords: model.unpricedRecords,
    sessions: 1,
  }));
}

export function resolveWeeklyApiEstimates(input: {
  readonly presentations: LimitPresentations;
  readonly now: number;
  readonly timeZone: string;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly dailyStatuses: readonly EnvironmentUsageStatus[];
  readonly hourlyStatusesByKey: ReadonlyMap<string, readonly EnvironmentUsageStatus[]>;
}): ReadonlyMap<string, WeeklyApiEstimateResult> {
  const pools = collectLimitPools(collectLimitAccounts(input.presentations), input.now);
  const results = new Map<string, WeeklyApiEstimateResult>();
  const selectedDaily = filterStatusesByEnvironment(
    input.dailyStatuses,
    input.selectedEnvironmentIds,
  );

  for (const pool of pools) {
    const accountCount = countDistinctDriverAccounts(
      pool.driver,
      pool.accounts.length,
      input.presentations,
    );
    for (const poolWindow of pool.windows) {
      if (poolWindow.kind !== "weekly") continue;
      const memberWindow = poolWindow.members[0]?.window;
      if (!memberWindow) continue;

      const key = windowEstimateKey(pool.driver, poolWindow);
      const usageProvider = driverUsageProvider(pool.driver);
      const matcher = resolveWeeklyWindowModelMatcher(pool.driver, memberWindow);
      const bounds = weeklyWindowBounds(memberWindow, input.now);

      if (
        usageProvider === null ||
        accountCount > 1 ||
        matcher === null ||
        bounds === null ||
        memberWindow.usedPercent < WEEKLY_API_ESTIMATE_MIN_USED_PERCENT
      ) {
        results.set(
          key,
          evaluateWeeklyApiEstimate({
            driver: pool.driver,
            window: memberWindow,
            now: input.now,
            timeZone: input.timeZone,
            accountCount,
            dailyBuckets: [],
            hourlyBuckets: [],
          }),
        );
        continue;
      }

      const plan = planWeeklyWindowUsageSlices(bounds.windowStartMs, input.now, input.timeZone);
      const dailyState =
        plan.dailyRange === null
          ? { isLoading: false, unavailable: false }
          : sliceStatusSummary(selectedDaily);
      const hourlyStates = plan.hourlyRanges.map((slice) => ({
        slice,
        statuses: filterStatusesByEnvironment(
          input.hourlyStatusesByKey.get(slice.key) ?? [],
          input.selectedEnvironmentIds,
        ),
      }));
      const hourlyLoading = hourlyStates.some(
        ({ statuses }) => sliceStatusSummary(statuses).isLoading,
      );
      const allUnavailable =
        (plan.dailyRange !== null && dailyState.unavailable) ||
        hourlyStates.some(({ statuses }) => sliceStatusSummary(statuses).unavailable);

      if (dailyState.isLoading || hourlyLoading) {
        results.set(key, { status: "loading" });
        continue;
      }
      if (allUnavailable) {
        results.set(key, { status: "unavailable", reason: "noLocalUsage" });
        continue;
      }

      const startDay = formatCalendarDayInZone(bounds.windowStartMs, input.timeZone);
      const nextDayMidnightMs = localDayStartMs(addCalendarDays(startDay, 1), input.timeZone);

      const dailyBuckets =
        plan.dailyRange === null
          ? []
          : deduplicateWindowBuckets(
              selectedDaily,
              (bucket) =>
                bucket.provider === usageProvider &&
                bucket.day >= plan.dailyRange!.sinceDay &&
                bucket.day <= plan.dailyRange!.untilDay &&
                matcher(bucket.model),
            ).map((bucket) => ({
              ...bucket,
              day: plan.dailyRange!.sinceDay as UsageBucket["day"],
            }));

      const hourlyBuckets = hourlyStates.flatMap(({ slice, statuses }) =>
        deduplicateWindowBuckets(statuses, (bucket) => {
          if (bucket.provider !== usageProvider || !matcher(bucket.model)) return false;
          if (bucket.hourStart === undefined) return true;
          const hourMs = Date.parse(bucket.hourStart);
          return (
            Number.isFinite(hourMs) &&
            hourMs + 60 * 60_000 > bounds.windowStartMs &&
            hourMs < nextDayMidnightMs
          );
        }).map((bucket) => ({
          ...bucket,
          day: slice.input.sinceDay,
          hourStart: slice.input.sinceTime,
        })),
      );

      results.set(
        key,
        evaluateWeeklyApiEstimate({
          driver: pool.driver,
          window: memberWindow,
          now: input.now,
          timeZone: input.timeZone,
          accountCount,
          dailyBuckets,
          hourlyBuckets,
        }),
      );
    }
  }

  return results;
}

const WHOLE_NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatWholeDollarAmount(value: number): string {
  return `$${WHOLE_NUMBER.format(Math.round(value))}`;
}

export interface WeeklyApiEstimateCopy {
  readonly text: string;
  readonly tooltip?: string;
}

export function formatWeeklyApiEstimateCopy(
  estimate: WeeklyApiEstimateResult | undefined,
  locale: string | undefined,
): WeeklyApiEstimateCopy | null {
  if (!estimate) return null;
  const isZh = locale?.toLowerCase().startsWith("zh") ?? false;

  if (estimate.status === "ready") {
    const weekly = formatWholeDollarAmount(estimate.weeklyUsd);
    const monthly = formatWholeDollarAmount(estimate.monthlyUsd);
    const cost = formatUsd(estimate.windowCostUsd, "en-US");
    const used = Number(estimate.usedPercent.toFixed(1));
    /* oxlint-disable t3code/no-untranslated-copy -- follow usage-speed precedent keeping fork copy out of GT translation catalogs */
    return isZh
      ? {
          text: `满额≈${weekly}/周 · 约${monthly}/月（API 估算）`,
          tooltip: `按本机记录估算，账号在别处也用时偏低（窗口内本机花费 ${cost}，已用 ${used}%）`,
        }
      : {
          text: `Full week ≈ ${weekly}/wk · ~${monthly}/mo (API est.)`,
          tooltip: `Estimated from local logs on this machine; lower if this account is also used elsewhere (${cost} local spend at ${used}% used)`,
        };
    /* oxlint-enable t3code/no-untranslated-copy */
  }

  if (estimate.status === "unavailable" && estimate.reason === "multiAccount") {
    /* oxlint-disable t3code/no-untranslated-copy -- follow usage-speed precedent keeping fork copy out of GT translation catalogs */
    return {
      text: isZh
        ? "多账号共用本机用量记录，暂不按账号估算"
        : "Multiple accounts share local usage logs; per-account estimate unavailable",
    };
    /* oxlint-enable t3code/no-untranslated-copy */
  }

  if (estimate.status === "loading") {
    /* oxlint-disable t3code/no-untranslated-copy -- follow usage-speed precedent keeping fork copy out of GT translation catalogs */
    return {
      text: isZh ? "正在估算周满额 API 费用…" : "Estimating full-week API value…",
    };
    /* oxlint-enable t3code/no-untranslated-copy */
  }

  return null;
}
