import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageBucket,
  UsageDay,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import { GTProvider } from "gt-react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { resolveWeeklyApiEstimates, windowEstimateKey } from "./weeklyApiEstimateModel.cn";

const checkedAt = "2026-11-24T06:00:00.000Z";
const now = Date.parse("2026-11-24T14:00:00+08:00");
const timeZone = "Asia/Shanghai";

function providerWithWindows(
  instanceId: string,
  driver: string,
  windows: readonly ServerProviderUsageWindow[],
  fingerprint?: string,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [...windows],
      ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    },
  };
}

function usageStatus(
  environmentId: EnvironmentId,
  provider: UsageBucket["provider"],
  buckets: readonly UsageBucket[],
): EnvironmentUsageStatus {
  return {
    environmentId,
    label: "Local",
    isPending: false,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: checkedAt,
      timeZone,
      sinceDay: UsageDay.make("2026-11-19"),
      untilDay: UsageDay.make("2026-11-24"),
      buckets: [...buckets],
      sources: [
        {
          fingerprint: {
            hostId: "host-1",
            provider,
            resolvedHomePath: `/tmp/${provider}`,
            volumeId: "vol-1",
          },
          status: "ok",
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 1,
          message: null,
        },
      ],
      pricing: {
        status: "fresh",
        source: "litellm",
        fetchedAt: checkedAt,
        knownModels: 10,
      },
      scanDurationMs: 10,
    },
  };
}

function bucket(
  day: string,
  provider: UsageBucket["provider"],
  model: string,
  costUsd: number,
  hourStart?: string,
): UsageBucket {
  return {
    day: UsageDay.make(day),
    ...(hourStart ? { hourStart } : {}),
    provider,
    model,
    sourcePath: `/tmp/${provider}`,
    totals: {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  };
}

describe("UsageLimitsPooled weekly API estimate", () => {
  it("renders the Claude Max weekly estimate in Chinese with lower-bound tooltip and hides ineligible rows", async () => {
    const envId = EnvironmentId.make("local");
    const presentations = new Map([
      [
        envId,
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              providerWithWindows("claudeAgent", "claudeAgent", [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 40,
                  resetsAt: "2026-11-24T17:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  id: "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  modelScope: { kind: "all" },
                  usedPercent: 21,
                  resetsAt: "2026-11-26T00:30:00.000Z",
                  windowDurationMins: 7 * 24 * 60,
                },
                {
                  id: "seven_day_fable",
                  kind: "weekly",
                  label: "Weekly · Fable",
                  modelScope: { kind: "patterns", includePrefixes: ["claude-fable-"] },
                  usedPercent: 8,
                  resetsAt: "2026-11-26T00:30:00.000Z",
                  windowDurationMins: 7 * 24 * 60,
                },
              ]),
              providerWithWindows(
                "antigravity",
                "antigravity",
                [
                  {
                    id: "3p-weekly",
                    kind: "weekly",
                    label: "Claude & GPT (shared) · Weekly",
                    modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
                    usedPercent: 35,
                    resetsAt: "2026-11-26T00:30:00.000Z",
                    windowDurationMins: 7 * 24 * 60,
                  },
                ],
                "ag-1",
              ),
              providerWithWindows(
                "antigravity_2",
                "antigravity",
                [
                  {
                    id: "3p-weekly",
                    kind: "weekly",
                    label: "Claude & GPT (shared) · Weekly",
                    modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
                    usedPercent: 18,
                    resetsAt: "2026-11-26T00:30:00.000Z",
                    windowDurationMins: 7 * 24 * 60,
                  },
                ],
                "ag-2",
              ),
            ],
          },
        },
      ],
    ]);

    const hourlyInputKey = JSON.stringify({
      sinceDay: "2026-11-19",
      untilDay: "2026-11-19",
      timeZone,
      resolution: "hour",
      sinceTime: "2026-11-19T00:30:00.000Z",
      untilTime: "2026-11-19T16:00:00.000Z",
    });

    const estimates = resolveWeeklyApiEstimates({
      presentations,
      now,
      timeZone,
      selectedEnvironmentIds: null,
      dailyStatuses: [
        usageStatus(envId, "claude", [
          bucket("2026-11-20", "claude", "claude-fable-5", 300),
          bucket("2026-11-21", "claude", "claude-opus-5-5", 478),
          bucket("2026-11-22", "claude", "claude-sonnet-5-5", 410.22),
        ]),
      ],
      hourlyStatusesByKey: new Map([
        [
          hourlyInputKey,
          [
            usageStatus(envId, "claude", [
              bucket("2026-11-19", "claude", "claude-fable-5", 244, "2026-11-19T00:30:00.000Z"),
            ]),
          ],
        ],
      ]),
    });

    expect(
      estimates.get(
        windowEstimateKey(ProviderDriverKind.make("claudeAgent"), {
          kind: "weekly",
          id: "seven_day",
        }),
      ),
    ).toMatchObject({ status: "ready", windowCostUsd: 1432.22 });

    await using screen = await render(
      <GTProvider locale="zh" translations={{}}>
        <UsageLimitsPooled presentations={presentations} now={now} weeklyEstimates={estimates} />
      </GTProvider>,
    );

    const estimateText = screen.getByText("满额≈$6,820/周 · 约$29,229/月（API 估算）");
    await expect.element(estimateText).toBeVisible();
    await estimateText.hover();
    await expect
      .element(
        page.getByText(
          "按本机记录估算，账号在别处也用时偏低（窗口内本机花费 $1,432.22，已用 21%）",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText("多账号共用本机用量记录，暂不按账号估算")).toBeVisible();
    // <10% 周窗口与 5 小时窗口不显示数字
    expect(screen.container.textContent).not.toContain("$0/周");
  });

  it("renders English estimate copy when locale is en", async () => {
    const envId = EnvironmentId.make("local");
    const presentations = new Map([
      [
        envId,
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              providerWithWindows("grok", "grok", [
                {
                  id: "subscription",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 81,
                  resetsAt: "2026-11-26T00:00:00.000Z",
                  windowDurationMins: 7 * 24 * 60,
                },
              ]),
            ],
          },
        },
      ],
    ]);
    const estimates = new Map([
      [
        windowEstimateKey(ProviderDriverKind.make("grok"), { kind: "weekly", id: "subscription" }),
        {
          status: "ready" as const,
          usageProvider: "grok" as const,
          usedPercent: 81,
          windowCostUsd: 35.43,
          weeklyUsd: 35.43 / 0.81,
          monthlyUsd: (35.43 / 0.81) * (30 / 7),
        },
      ],
    ]);

    await using screen = await render(
      <GTProvider locale="en" translations={{}}>
        <UsageLimitsPooled presentations={presentations} now={now} weeklyEstimates={estimates} />
      </GTProvider>,
    );

    await expect
      .element(screen.getByText("Full week ≈ $44/wk · ~$187/mo (API est.)"))
      .toBeVisible();
  });
});
