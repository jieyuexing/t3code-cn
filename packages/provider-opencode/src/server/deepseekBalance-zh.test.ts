import * as NodeAssert from "node:assert/strict";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readDeepseekBalanceUsageLimits } from "./deepseekBalance-zh.ts";

const checkedAt = "2026-11-10T00:00:00.000Z";

const readLimits = (
  environment: NodeJS.ProcessEnv,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  readDeepseekBalanceUsageLimits({ environment, checkedAt }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
      ),
    ),
    Effect.provide(NodeCrypto.layer),
  );

it.effect("shows a healthy CNY balance as a full window", () =>
  Effect.gen(function* () {
    const limits = yield* readLimits({ DEEPSEEK_API_KEY: "fake-key" }, (request) => {
      NodeAssert.equal(request.url, "https://api.deepseek.com/user/balance");
      NodeAssert.equal(request.headers.authorization, "Bearer fake-key");
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "108.04" }],
      });
    });
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.deepEqual(limits.windows, [
      { id: "deepseek_balance", kind: "other", label: "余额 108.04 元", usedPercent: 0 },
    ]);
    NodeAssert.equal(typeof limits.credentialFingerprint, "string");
  }),
);

it.effect("fills the window as the balance drops toward the monthly budget", () =>
  Effect.gen(function* () {
    const limits = yield* readLimits({ DEEPSEEK_API_KEY: "fake-key" }, () =>
      Response.json({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "30.00" }],
      }),
    );
    NodeAssert.equal(limits.windows.length, 1);
    NodeAssert.equal(limits.windows[0]?.usedPercent, 70);
  }),
);

it.effect("reports an unavailable account as fully used", () =>
  Effect.gen(function* () {
    const limits = yield* readLimits({ DEEPSEEK_API_KEY: "fake-key" }, () =>
      Response.json({
        is_available: false,
        balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
      }),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.equal(limits.windows[0]?.usedPercent, 100);
  }),
);

it.effect("turns a failed request into a probe failure without the key", () =>
  Effect.gen(function* () {
    const limits = yield* readLimits({ DEEPSEEK_API_KEY: "fake-secret" }, () =>
      Response.json({ error: "boom" }, { status: 500 }),
    );
    NodeAssert.equal(limits.unavailable?.reason, "probeFailed");
    NodeAssert.deepEqual(limits.windows, []);
    NodeAssert.ok(!limits.unavailable?.message?.includes("fake-secret"));
  }),
);

it.effect("turns a missing CNY balance into a probe failure", () =>
  Effect.gen(function* () {
    const limits = yield* readLimits({ DEEPSEEK_API_KEY: "fake-key" }, () =>
      Response.json({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "12.00" }],
      }),
    );
    NodeAssert.equal(limits.unavailable?.reason, "probeFailed");
    NodeAssert.deepEqual(limits.windows, []);
  }),
);

it.effect("reports unsupported without a key and makes no request", () =>
  readDeepseekBalanceUsageLimits({ environment: {}, checkedAt }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected balance request without a key")),
    ),
    Effect.provide(NodeCrypto.layer),
    Effect.map((limits) => {
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
      NodeAssert.deepEqual(limits.windows, []);
    }),
  ),
);
