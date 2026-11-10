import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
// 100 元对应用户的 DeepSeek 月上限，余额越低进度条越满。
const DEEPSEEK_MONTHLY_BUDGET_CNY = 100;

const BalanceResponse = Schema.Struct({
  is_available: Schema.Boolean,
  balance_infos: Schema.Array(
    Schema.Struct({ currency: Schema.String, total_balance: Schema.String }),
  ),
});

/** DeepSeek 实例按账户余额显示额度；key 只进请求头，不进错误信息。 */
export const readDeepseekBalanceUsageLimits = Effect.fn("readDeepseekBalanceUsageLimits")(
  function* (input: { readonly environment: NodeJS.ProcessEnv; readonly checkedAt?: string }) {
    const checkedAt = input.checkedAt ?? DateTime.formatIso(yield* DateTime.now);
    const apiKey = input.environment.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });

    return yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get(BALANCE_URL).pipe(HttpClientRequest.bearerToken(apiKey)),
      );
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(BalanceResponse)),
      );
      const cny = body.balance_infos.find((info) => info.currency === "CNY");
      const rawBalance = cny?.total_balance.trim();
      const balance = rawBalance ? Number(rawBalance) : Number.NaN;
      if (rawBalance === undefined || !Number.isFinite(balance)) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "DeepSeek 余额接口没有有效的 CNY 余额",
        });
      }
      const digest = yield* Digest.Digest;
      const credentialFingerprint = yield* digest
        .digest(Digest.sha256, new TextEncoder().encode(`deepseek\0${apiKey}`))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      return {
        ...makeUsageLimits({
          checkedAt,
          windows: [
            {
              id: "deepseek_balance",
              kind: "other",
              label: `余额 ${rawBalance} 元`,
              usedPercent: body.is_available
                ? clampPercent(
                    100 -
                      (Math.min(balance, DEEPSEEK_MONTHLY_BUDGET_CNY) /
                        DEEPSEEK_MONTHLY_BUDGET_CNY) *
                        100,
                  )
                : 100,
            },
          ],
        }),
        credentialFingerprint,
      };
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "DeepSeek 余额查询失败。",
        }),
      ),
    );
  },
);
