import { formatCount, formatDayShort, formatTokens } from "@t3tools/shared/usageFormat";
import type { SpeedRanking } from "@t3tools/shared/usageSpeed";
import {
  SPEED_LONG_OUTPUT_TOKENS,
  SPEED_LOW_SAMPLE_LONG_REQUESTS,
} from "@t3tools/shared/usageSpeed";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { UsageShareImage } from "./UsageShareImage";
import {
  formatRate,
  formatSeconds,
  speedBarShares,
  speedBarValue,
  speedDay,
  speedModelLabel,
} from "./usageSpeedView";

const HATCH = (color: string) =>
  `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`;

function presentationOf(provider: string) {
  return provider in PROVIDER_PRESENTATION
    ? PROVIDER_PRESENTATION[provider as keyof typeof PROVIDER_PRESENTATION]
    : undefined;
}

export function UsageSpeed({
  ranking,
  timeZone,
  period,
  loading,
}: {
  readonly ranking: readonly SpeedRanking[];
  readonly timeZone: string;
  readonly period: { readonly sinceDay: string; readonly untilDay: string };
  readonly loading: boolean;
}) {
  const shares = speedBarShares(ranking);
  const showDispatch = ranking.some((row) => row.dispatch !== null);
  return (
    <section aria-busy={loading} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Output speed</h2>
          <UsageShareImage ranking={ranking} period={period} />
        </div>
        <p className="max-w-3xl text-xs text-muted-foreground">
          Output tokens, thinking included, divided by the wall-clock time of one model request,
          measured on this machine. Time to first token, network and queueing count. The bar is the
          median of requests with at least {formatCount(SPEED_LONG_OUTPUT_TOKENS)} output tokens;
          latency is the median of requests with 100 to 300.
        </p>
        <p className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-1.5 w-6 rounded-full bg-muted-foreground" />
            {SPEED_LOW_SAMPLE_LONG_REQUESTS}+ long requests
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-1.5 w-6 rounded-full"
              style={{ backgroundImage: HATCH("var(--muted-foreground)") }}
            />
            Few samples, or none long: bar shows every request
          </span>
        </p>
      </div>
      <table className={cn("w-full text-sm transition-opacity", loading && "opacity-40")}>
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="py-2 pr-3 pl-2 text-left font-normal">#</th>
            <th className="py-2 text-left font-normal">Model</th>
            <th className="hidden py-2 pl-4 text-left font-normal md:table-cell">Channel</th>
            <th className="w-full py-2 pl-6 text-left font-normal">Long output</th>
            <th className="py-2 pl-4 font-normal">tok/s</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Short latency</th>
            <th className={cn("py-2 pl-6 font-normal", !showDispatch && "pr-2")}>Requests</th>
            {showDispatch ? (
              <th className="py-2 pr-2 pl-6 font-normal">
                <Tooltip>
                  <TooltipTrigger render={<span />}>Dispatch success</TooltipTrigger>
                  <TooltipPopup>
                    Successful dispatches over all dispatches of this model, all time, from the
                    configured score file.
                  </TooltipPopup>
                </Tooltip>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {ranking.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-6 text-center text-muted-foreground">
                No timed requests in this window.
              </td>
            </tr>
          ) : (
            ranking.map((row, index) => {
              const presentation = presentationOf(row.provider);
              const color = presentation?.color ?? "var(--muted-foreground)";
              const bar = speedBarValue(row);
              return (
                <tr
                  key={`${row.provider}:${row.model}:${row.tier ?? ""}`}
                  className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50"
                >
                  <td className="py-2.5 pr-3 pl-2 text-left text-xs">{index + 1}</td>
                  <td className="py-2.5 text-left">
                    <Tooltip>
                      <TooltipTrigger
                        render={<span className="flex items-center gap-2 text-foreground" />}
                      >
                        {presentation === undefined ? null : (
                          <ProviderInstanceIcon
                            driverKind={presentation.driverKind}
                            displayName={presentation.label}
                            iconClassName="size-3.5"
                          />
                        )}
                        {speedModelLabel(row)}
                      </TooltipTrigger>
                      <TooltipPopup>
                        {row.allRate === null
                          ? null
                          : `All requests ${formatRate(row.allRate)} tok/s · `}
                        {formatTokens(row.outputTokens)} output tokens ·{" "}
                        {formatDayShort(speedDay(row.firstMs, timeZone))} to{" "}
                        {formatDayShort(speedDay(row.lastMs, timeZone))}
                      </TooltipPopup>
                    </Tooltip>
                  </td>
                  <td className="hidden py-2.5 pl-4 text-left text-xs md:table-cell">
                    {presentation?.label ?? row.provider}
                  </td>
                  <td className="py-2.5 pl-6 text-left">
                    <div aria-hidden className="h-1.5 max-w-64 min-w-16">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `max(0.5rem, ${(shares[index] ?? 0) * 100}%)`,
                          ...(bar.thin
                            ? { backgroundImage: HATCH(color) }
                            : { backgroundColor: color }),
                        }}
                      />
                    </div>
                  </td>
                  <td className="py-2.5 pl-4 text-foreground">
                    {row.longRate === null ? "-" : formatRate(row.longRate)}
                  </td>
                  <td className="hidden py-2.5 pl-6 sm:table-cell">
                    {row.shortSeconds === null ? "-" : formatSeconds(row.shortSeconds)}
                  </td>
                  <td className={cn("py-2.5 pl-6", !showDispatch && "pr-2")}>
                    {formatCount(row.longRequests)} / {formatCount(row.requests)}
                  </td>
                  {showDispatch ? (
                    <td className="py-2.5 pr-2 pl-6">
                      {row.dispatch === null
                        ? "-"
                        : `${formatCount(row.dispatch.successes)}/${formatCount(row.dispatch.total)}`}
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </section>
  );
}
