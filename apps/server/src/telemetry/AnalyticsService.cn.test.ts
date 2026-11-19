import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const sentRequests = (
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  afterFirstFlush?: () => void,
) =>
  Effect.gen(function* () {
    const urls: Array<string> = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });
    const layer = AnalyticsService.layer.pipe(
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-cn-" }),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
          Layer.succeed(HostProcess.Environment, env),
          Layer.succeed(HttpClient.HttpClient, client),
          ManagedPolicy.layerTest(),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("test.event");
      yield* analytics.flush;
      afterFirstFlush?.();
      yield* analytics.record("test.event.after");
      yield* analytics.flush;
    }).pipe(Effect.provide(layer));
    return urls;
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("fork telemetry default", (it) => {
  it.effect("sends nothing unless T3CODE_TELEMETRY_ENABLED is set", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* sentRequests({}, {}), []);
    }),
  );

  it.effect("still sends when T3CODE_TELEMETRY_ENABLED=true", () =>
    Effect.gen(function* () {
      const urls = yield* sentRequests({ T3CODE_TELEMETRY_ENABLED: true }, {});
      assert.isAbove(urls.length, 0);
    }),
  );

  it.effect("an explicit opt-in survives the desktop shell dropping the variable", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const urls = yield* sentRequests(
        { T3CODE_TELEMETRY_ENABLED: true },
        env,
        () => delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING,
      );
      assert.isAbove(urls.length, 0);
    }),
  );

  it.effect("a desktop shell without the variable stays off by default", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      assert.deepEqual(
        yield* sentRequests({}, env, () => delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING),
        [],
      );
    }),
  );
});
