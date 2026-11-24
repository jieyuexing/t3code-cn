import { useAtomValue } from "@effect/atom-react";
import { refreshUsage } from "@t3tools/client-runtime/state/usage";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import {
  resolveViewerTimeZone,
  type WeeklyApiEstimateResult,
} from "@t3tools/shared/usageLimitsApiEstimate.cn";
import { Atom } from "effect/reactivity";
import { useLocale } from "gt-react";
import { InfoIcon } from "lucide-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { usageByWindowAtom, type EnvironmentUsageStatus } from "../../state/usage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildWeeklyEstimateQueryBundle,
  formatWeeklyApiEstimateCopy,
  resolveWeeklyApiEstimates,
} from "./weeklyApiEstimateModel.cn";

const weeklyUsageBundleAtom = Atom.family((bundleKey: string) =>
  Atom.make((get) => {
    const parsed = JSON.parse(bundleKey) as {
      readonly dailyInput: UsageSummaryInput | null;
      readonly hourlyInputs: readonly UsageSummaryInput[];
    };
    const dailyStatuses = parsed.dailyInput
      ? get(usageByWindowAtom(JSON.stringify(parsed.dailyInput)))
      : [];
    const hourlyStatuses = parsed.hourlyInputs.map(
      (input) => [JSON.stringify(input), get(usageByWindowAtom(JSON.stringify(input)))] as const,
    );
    return { dailyStatuses, hourlyStatuses };
  }).pipe(Atom.withLabel(`web-usage:limits-weekly-bundle:${bundleKey}`)),
);

export function useWeeklyApiEstimates({
  presentations,
  selectedEnvironmentIds,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
}): ReadonlyMap<string, WeeklyApiEstimateResult> {
  const timeZone = resolveViewerTimeZone();
  const bundle = buildWeeklyEstimateQueryBundle(presentations, now, timeZone);
  const { dailyStatuses, hourlyStatuses } = useAtomValue(weeklyUsageBundleAtom(bundle.bundleKey));

  return resolveWeeklyApiEstimates({
    presentations,
    now,
    timeZone,
    selectedEnvironmentIds,
    dailyStatuses,
    hourlyStatusesByKey: new Map<string, readonly EnvironmentUsageStatus[]>(hourlyStatuses),
  });
}

export async function refreshWeeklyApiEstimates({
  presentations,
  selectedEnvironmentIds,
  now,
  environmentIds,
}: {
  readonly presentations: LimitPresentations;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
  readonly environmentIds: readonly EnvironmentId[];
}): Promise<void> {
  const readableIds = environmentIds.filter((environmentId) =>
    readEnvironmentScope(environmentId, AuthDiagnosticsReadScope),
  );
  if (readableIds.length === 0) return;
  const scoped =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const bundle = buildWeeklyEstimateQueryBundle(scoped, now, resolveViewerTimeZone());
  const inputs: UsageSummaryInput[] = [
    ...(bundle.dailyInput ? [bundle.dailyInput] : []),
    ...bundle.hourlyInputs,
  ];
  await Promise.all(
    inputs.map((input) =>
      refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        environmentIds: readableIds,
        input,
      }),
    ),
  );
}

export function WeeklyApiEstimateLine({
  estimate,
}: {
  readonly estimate: WeeklyApiEstimateResult | undefined;
}) {
  const locale = useLocale();
  const copy = formatWeeklyApiEstimateCopy(estimate, locale);
  if (copy === null) return null;

  if (!copy.tooltip) {
    return <p className="text-xs text-muted-foreground md:col-span-2">{copy.text}</p>;
  }

  return (
    <p className="text-xs text-muted-foreground tabular-nums md:col-span-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="inline-flex cursor-default items-center gap-1 rounded-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span>{copy.text}</span>
          <InfoIcon className="size-3 shrink-0" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">{copy.tooltip}</TooltipPopup>
      </Tooltip>
    </p>
  );
}
