import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import { Headers } from "effect/http";
import { RpcMessage, RpcServer } from "effect/rpc";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "../orchestration-v2/NativeChildWorkQuery.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import * as Keybindings from "../keybindings.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as PluginHost from "./PluginHost.ts";

// Fixture copied from ws.test.ts (layerUnusedConfigRpcServices, layerConfigSources); diff against it when ws.ts gains a service.
const layerRpcServices = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(TextGenerators.TextGenerators)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(NpmRelease.NpmRelease)({}),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
  Layer.mock(DirectEndpoints.DirectEndpoints)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  AssetSigner.layer.pipe(Layer.provide(ServerSecretStore.layer)),
  ServerSettings.layer.pipe(
    Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layerTest())),
  ),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

interface PluginSnapshotShape {
  readonly plugins: ReadonlyArray<{ readonly state: { readonly _tag: string } }>;
  readonly views: ReadonlyArray<unknown>;
  readonly commands: ReadonlyArray<unknown>;
}

it.live("plugin host: enable, invoke and disable through the websocket layer, gated by scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-ws-" });
    const pluginDirectory = path.join(root, "echo-clock");
    yield* fs.copy(
      `${import.meta.dirname}/../../../../plugin-host-examples/echo-clock`,
      pluginDirectory,
    );
    const host = yield* PluginHost.make({
      stateDir: path.join(root, "state"),
      command: process.execPath,
      args: [`${import.meta.dirname}/child.mjs`],
    });
    const services = Layer.mergeAll(layerRpcServices, Layer.succeed(PluginHost.PluginHost, host));
    const serverBrowser = yield* ServerBrowser.ServerBrowser;

    const connect = Effect.fn("connect")(function* (
      scopes: ReadonlyArray<"environment:maintain" | "orchestration:read">,
    ) {
      const snapshots = yield* Queue.unbounded<PluginSnapshotShape>();
      const exits = yield* Queue.unbounded<Exit.Exit<{ readonly value: unknown }, unknown>>();
      const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) =>
          response._tag === "Chunk"
            ? Effect.forEach(response.values, (value) => Queue.offer(snapshots, value as never), {
                discard: true,
              })
            : response._tag === "Exit"
              ? Queue.offer(exits, response.exit as never)
              : Effect.void,
      }).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("plugin-host-test"),
              subject: "plugin-host-test",
              method: "browser-session-cookie",
              scopes: [...scopes],
            },
            {},
            serverBrowser,
            () => Effect.void,
            { secretReferences: true },
          ).pipe(Layer.provide(services), Layer.merge(RpcAuthorization.layer([...scopes]))),
        ),
      );
      const requestId = RpcMessage.RequestId("snapshots");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.pluginHostSubscribe,
        payload: {},
        headers: Headers.empty,
      });
      let calls = 0;
      const nextSnapshot = Queue.take(snapshots).pipe(Effect.tap(() => acknowledge));
      return {
        nextSnapshot,
        waitFor: Effect.fn("waitFor")(function* (
          predicate: (snapshot: PluginSnapshotShape) => boolean,
        ) {
          while (true) {
            const snapshot = yield* nextSnapshot;
            if (predicate(snapshot)) return snapshot;
          }
        }),
        call: Effect.fn("call")(function* (payload: object) {
          yield* server.write(0, {
            _tag: "Request",
            id: RpcMessage.RequestId(`call-${(calls += 1)}`),
            tag: WS_METHODS.pluginHostCall,
            payload,
            headers: Headers.empty,
          });
          return yield* Queue.take(exits);
        }),
      };
    });
    const readOnly = yield* connect(["orchestration:read"]);
    const denied = yield* readOnly.call({ _tag: "add", path: pluginDirectory });
    assert.equal(denied._tag, "Failure");

    const client = yield* connect(["environment:maintain", "orchestration:read"]);
    assert.deepEqual((yield* client.nextSnapshot).plugins, []);
    const pluginId = "example.echo-clock";
    assert.equal((yield* client.call({ _tag: "add", path: pluginDirectory }))._tag, "Success");
    assert.equal(
      (yield* client.call({ _tag: "enable", pluginId, grantConsent: true }))._tag,
      "Success",
    );
    const running = yield* client.waitFor(
      (snapshot) => snapshot.plugins[0]?.state._tag === "running",
    );
    assert.equal(running.views.length, 1);
    assert.equal(running.commands.length, 1);

    const echoed = yield* client.call({
      _tag: "invoke",
      pluginId,
      handler: "echo",
      input: { a: 1 },
    });
    assert.deepEqual(Exit.isSuccess(echoed) ? echoed.value : undefined, { value: { a: 1 } });

    assert.equal((yield* client.call({ _tag: "disable", pluginId }))._tag, "Success");
    const stopped = yield* client.waitFor((snapshot) => snapshot.plugins[0]?.state._tag === "idle");
    assert.deepEqual([stopped.views, stopped.commands], [[], []]);
    const afterStop = yield* client.call({
      _tag: "invoke",
      pluginId,
      handler: "echo",
      input: null,
    });
    assert.equal(afterStop._tag, "Failure");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    ),
    Effect.scoped,
  ),
);
