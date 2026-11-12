import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("The Grok probe must not make an HTTP request")),
    ),
  ),
);

const LOGGED_IN = "You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.6 (default)\n";
const LOGGED_OUT = "You are not authenticated.\n\nAvailable models:\n  * grok-4.6 (default)\n";

// Serves `grok models` outputs in call order and repeats the last one.
const writeFakeGrokCli = (modelsOutputs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-auth-" });
    const binaryPath = writeFakeCli({
      directory,
      name: "grok",
      source: [
        'if (process.argv[2] === "--version") { process.stdout.write("grok 1.0.13\\n"); process.exit(0); }',
        'if (process.argv[2] === "models") {',
        '  const fs = await import("node:fs");',
        `  const callsPath = ${JSON.stringify(`${directory}/models-calls`)};`,
        '  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").length : 0;',
        '  fs.appendFileSync(callsPath, ".");',
        `  const outputs = ${JSON.stringify(modelsOutputs)};`,
        "  process.stdout.write(outputs[Math.min(calls, outputs.length - 1)]);",
        "  process.exit(0);",
        "}",
        "process.exit(3);",
        "",
      ].join("\n"),
    });
    return { binaryPath, directory };
  });

it.layer(layerTest)("GrokDriver login verdict", (it) => {
  // A logged-in CLI may print the logged-out banner while it refreshes an expired token. Each
  // refresh probes twice (`grok models`, then a recheck), so two logged-out outputs are one verdict.
  it.effect(
    "keeps a logged-in Grok runnable through one logged-out verdict and reports a repeated one",
    () =>
      Effect.gen(function* () {
        const { binaryPath, directory } = yield* writeFakeGrokCli([
          LOGGED_IN, // the probe create() starts
          LOGGED_IN, // first refresh
          LOGGED_OUT, // every later probe
        ]);
        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-login-flap"),
          displayName: "Grok test",
          enabled: true,
          environment: [
            { name: "XAI_API_KEY", value: "", sensitive: false },
            { name: "GROK_HOME", value: directory, sensitive: false },
          ],
          config: { ...GrokDriver.defaultConfig(), enabled: true, binaryPath },
        });

        const first = yield* instance.snapshot.refresh;
        expect(first.auth.status).toBe("authenticated");

        // Two further probes of the same refresh print the logged-out banner.
        const second = yield* instance.snapshot.refresh;
        expect(second.auth.status).not.toBe("unauthenticated");
        expect(second.status).not.toBe("error");

        const third = yield* instance.snapshot.refresh;
        expect(third.auth.status).toBe("unauthenticated");
        expect(third.status).toBe("error");
      }).pipe(Effect.scoped),
  );
});
