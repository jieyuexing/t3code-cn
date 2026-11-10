import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpPlatform, HttpRouter } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layerAssetRoute } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as PluginHost from "./PluginHost.ts";
import { CHILD } from "./testChild.ts";
import { issueViewUrl } from "./PluginViewDelivery.ts";

const EXAMPLE = `${import.meta.dirname}/../../../../plugin-host-examples/echo-clock`;
const pluginId = "example.echo-clock" as never;

// Fixture copied from AssetAccess.test.ts (layerTest): what the asset route needs to resolve a signed attachment URL.
const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-plugin-views-test-",
});
const layerRoute = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.live("a view page is served by the signed asset route with the MCP app CSP", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-views-" });
    const directory = path.join(root, "echo-clock");
    yield* fs.copy(EXAMPLE, directory);
    const host = yield* PluginHost.make({
      stateDir: path.join(root, "state"),
      ...CHILD,
      attachmentsDir: config.attachmentsDir,
      issueUrl: issueViewUrl,
    });
    yield* host.call({ _tag: "setHostEnabled", enabled: true });
    yield* host.call({ _tag: "add", path: directory });
    yield* host.call({ _tag: "enable", pluginId, grantConsent: true });
    const head = yield* host.subscribe.pipe(Stream.runHead);
    const generation = head._tag === "Some" ? head.value.plugins[0]!.generation : -1;
    const { value } = yield* host.call({ _tag: "readView", pluginId, viewId: "clock", generation });
    const { url, expiresAt } = value as { url: string; expiresAt: number };
    expect(url).toMatch(/^\/api\/assets\/[^/]+\.[^/]+\/[^/]+$/);
    expect(Number.isFinite(expiresAt)).toBe(true);

    const context = yield* Effect.context<
      | AssetSigner.AssetSigner
      | FileSystem.FileSystem
      | HttpPlatform.HttpPlatform
      | NativeAppIconResolver.NativeAppIconResolver
      | Orchestrator.OrchestratorV2
      | Path.Path
      | RepositoryIdentityResolver.RepositoryIdentityResolver
      | ServerConfig.ServerConfig
      | BuiltInDrivers.SourceControlDrivers
      | WorkspacePaths.WorkspacePaths
    >();
    const { handler, dispose } = HttpRouter.toWebHandler(
      layerAssetRoute.pipe(Layer.provide(Layer.succeedContext(context))),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
    const response = yield* Effect.promise(() =>
      handler(new Request(`http://localhost${url}`), context),
    );
    const body = yield* Effect.promise(() => response.text());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(body).toContain("Content-Security-Policy");
    expect(body).toContain("default-src 'none'");
    expect(body).toContain("t3-view:ready");

    const tampered = url.replace(/\.[^/]+\//, ".AAAA/");
    const refused = yield* Effect.promise(() =>
      handler(new Request(`http://localhost${tampered}`), context),
    );
    expect(refused.status).toBe(404);

    yield* host.call({ _tag: "disable", pluginId });
    const gone = yield* Effect.promise(() =>
      handler(new Request(`http://localhost${url}`), context),
    );
    expect(gone.status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(layerRoute)),
);
