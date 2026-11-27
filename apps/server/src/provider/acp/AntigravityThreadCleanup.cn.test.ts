import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as Settings from "../../serverSettings.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as PendingSettleScripts from "../../orchestration-v2/PendingSettleScripts.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as TaskFolders from "../../workspace/TaskFolders.ts";
import { resolveAntigravityInstanceDirectories } from "../antigravityAuthSupport.ts";
import { cleanDeletedAntigravitySessions } from "./AntigravityThreadCleanup.cn.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";
const SESSION_E = "55555555-5555-4555-8555-555555555555";
const SESSION_F = "66666666-6666-4666-8666-666666666666";
const NOW_MS = Date.parse("2026-11-23T12:00:00.000Z");
const TIMESTAMP = DateTime.formatIso(DateTime.makeUnsafe(NOW_MS));

const testBaseLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agy-cleanup-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, Sqlite.layerMemory)),
);

const createSessionFiles = Effect.fn("test.createSessionFiles")(function* (input: {
  readonly profileDir: string;
  readonly sessionId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const acpDir = path.join(input.profileDir, "antigravity-acp");
  const conversationsDir = path.join(acpDir, "conversations");
  const brainDir = path.join(acpDir, "brain", input.sessionId);
  const annotationsDir = path.join(acpDir, "annotations");
  yield* fs.makeDirectory(conversationsDir, { recursive: true });
  yield* fs.makeDirectory(brainDir, { recursive: true });
  yield* fs.makeDirectory(annotationsDir, { recursive: true });

  const base = path.join(conversationsDir, input.sessionId);
  const files = {
    db: `${base}.db`,
    wal: `${base}.db-wal`,
    shm: `${base}.db-shm`,
    journal: `${base}.db-journal`,
    meta: `${base}.meta`,
    brainDir,
    brainArtifact: path.join(brainDir, "plan.md"),
    annotation: path.join(annotationsDir, `${input.sessionId}.pbtxt`),
  };
  yield* fs.writeFileString(files.db, "db");
  yield* fs.writeFileString(files.wal, "wal");
  yield* fs.writeFileString(files.shm, "shm");
  yield* fs.writeFileString(files.journal, "journal");
  yield* fs.writeFileString(files.meta, "{}");
  yield* fs.writeFileString(files.brainArtifact, "plan");
  yield* fs.writeFileString(files.annotation, "annotation");
  return files;
});

const makeDbHelpers = Effect.fn("test.makeDbHelpers")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertThread = Effect.fn("test.insertThread")(function* (input: {
    readonly threadId: string;
    readonly deleted?: boolean;
    readonly forkedFromThreadId?: string;
    readonly parentThreadId?: string;
    readonly defaultProvider?: string;
  }) {
    const provider = input.defaultProvider ?? "antigravity";
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: input.threadId,
      project_id: "project-1",
      title: input.threadId,
      default_provider: provider,
      provider_instance_id: provider,
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      archived_at: null,
      deleted_at: input.deleted ? TIMESTAMP : null,
      payload_json: JSON.stringify({
        id: input.threadId,
        forkedFrom: input.forkedFromThreadId
          ? { type: "run", threadId: input.forkedFromThreadId, runId: `run-${input.threadId}` }
          : null,
        lineage: {
          rootThreadId: input.parentThreadId ?? input.threadId,
          parentThreadId: input.parentThreadId ?? null,
          relationshipToParent: input.parentThreadId ? "subagent" : null,
        },
      }),
    })}`;
  });

  const insertProviderThread = Effect.fn("test.insertProviderThread")(function* (input: {
    readonly providerThreadId: string;
    readonly threadId: string;
    readonly driver?: string;
    readonly providerInstanceId?: string;
    readonly providerSessionId?: string | null;
    readonly nativeSessionId: string | null;
  }) {
    const driver = input.driver ?? "antigravity";
    const instanceId = input.providerInstanceId ?? driver;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
      provider_thread_id: input.providerThreadId,
      thread_id: input.threadId,
      owner_node_id: null,
      provider: instanceId,
      driver,
      provider_instance_id: instanceId,
      provider_session_id: input.providerSessionId ?? null,
      status: "idle",
      first_run_ordinal: 1,
      last_run_ordinal: 1,
      updated_at: TIMESTAMP,
      payload_json: JSON.stringify({
        id: input.providerThreadId,
        driver,
        providerInstanceId: instanceId,
        nativeThreadRef:
          input.nativeSessionId === null
            ? null
            : { driver, nativeId: input.nativeSessionId, strength: "strong" },
      }),
    })}`;
  });

  const insertRunAndAttempt = Effect.fn("test.insertRunAndAttempt")(function* (input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly threadId: string;
    readonly providerThreadId: string;
    readonly providerInstanceId?: string;
    readonly nativeThreadId: string;
  }) {
    const instanceId = input.providerInstanceId ?? "antigravity";
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: input.runId,
      thread_id: input.threadId,
      ordinal: 1,
      provider: instanceId,
      provider_instance_id: instanceId,
      provider_thread_id: input.providerThreadId,
      status: "completed",
      requested_at: TIMESTAMP,
      completed_at: TIMESTAMP,
      payload_json: JSON.stringify({ id: input.runId }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: input.attemptId,
      thread_id: input.threadId,
      run_id: input.runId,
      attempt_ordinal: 1,
      root_node_id: `node-${input.attemptId}`,
      provider: instanceId,
      provider_instance_id: instanceId,
      provider_thread_id: input.providerThreadId,
      provider_turn_id: null,
      status: "completed",
      payload_json: JSON.stringify({
        id: input.attemptId,
        providerInstanceId: instanceId,
        nativeThreadId: input.nativeThreadId,
      }),
    })}`;
  });

  const insertProviderSession = Effect.fn("test.insertProviderSession")(function* (input: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly driver?: string;
    readonly providerInstanceId?: string;
    readonly status?: string;
  }) {
    const driver = input.driver ?? "antigravity";
    const instanceId = input.providerInstanceId ?? driver;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions ${sql.insert({
      provider_session_id: input.sessionId,
      thread_id: input.threadId,
      provider: instanceId,
      driver,
      provider_instance_id: instanceId,
      status: input.status ?? "stopped",
      model: null,
      updated_at: TIMESTAMP,
      payload_json: JSON.stringify({ id: input.sessionId, driver, providerInstanceId: instanceId }),
    })}`;
  });

  const insertOutbox = Effect.fn("test.insertOutbox")(function* (input: {
    readonly effectId: string;
    readonly threadId: string;
    readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  }) {
    yield* sql`INSERT INTO orchestration_v2_effect_outbox ${sql.insert({
      effect_id: input.effectId,
      command_id: `cmd-${input.effectId}`,
      thread_id: input.threadId,
      effect_type: "provider.stop",
      payload_json: "{}",
      status: input.status,
      attempt_count: 0,
      available_at: TIMESTAMP,
      lease_owner: null,
      lease_expires_at: null,
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      completed_at: null,
      last_error: null,
    })}`;
  });

  return {
    sql,
    insertThread,
    insertProviderThread,
    insertRunAndAttempt,
    insertProviderSession,
    insertOutbox,
  };
});

describe("AntigravityThreadCleanup", () => {
  it.effect(
    "cleans deleted idle Antigravity sessions and preserves active threads, other providers, and conversation_summaries.db",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const db = yield* makeDbHelpers();

        const { profile: profileDefault } = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make("antigravity"),
        );
        const { profile: profileSecondary } = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make("antigravity_2"),
        );

        const deletedFiles = yield* createSessionFiles({
          profileDir: profileDefault,
          sessionId: SESSION_A,
        });
        const deletedSecondaryFiles = yield* createSessionFiles({
          profileDir: profileSecondary,
          sessionId: SESSION_B,
        });
        const activeFiles = yield* createSessionFiles({
          profileDir: profileDefault,
          sessionId: SESSION_C,
        });
        const otherProviderFiles = yield* createSessionFiles({
          profileDir: profileDefault,
          sessionId: SESSION_D,
        });
        const summariesPath = path.join(
          profileDefault,
          "antigravity-acp",
          "conversation_summaries.db",
        );
        yield* fs.writeFileString(summariesPath, "summaries");

        yield* db.insertThread({ threadId: "thread-deleted-1", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-deleted-1",
          threadId: "thread-deleted-1",
          providerInstanceId: "antigravity",
          nativeSessionId: SESSION_A,
        });

        yield* db.insertThread({ threadId: "thread-deleted-2", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-deleted-2",
          threadId: "thread-deleted-2",
          providerInstanceId: "antigravity_2",
          nativeSessionId: SESSION_B,
        });

        yield* db.insertThread({ threadId: "thread-active", deleted: false });
        yield* db.insertProviderThread({
          providerThreadId: "pt-active",
          threadId: "thread-active",
          providerInstanceId: "antigravity",
          nativeSessionId: SESSION_C,
        });

        // Deleted codex thread should not trigger cleanup even if its native id matches an Antigravity file.
        yield* db.insertThread({
          threadId: "thread-deleted-codex",
          deleted: true,
          defaultProvider: "codex",
        });
        yield* db.insertProviderThread({
          providerThreadId: "pt-deleted-codex",
          threadId: "thread-deleted-codex",
          driver: "codex",
          providerInstanceId: "codex",
          nativeSessionId: SESSION_D,
        });

        const result = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions: { isLive: () => Effect.succeed(false) },
        });

        expect(result).toEqual({ waiting: false, removedSessions: 2 });
        for (const removedPath of [
          deletedFiles.db,
          deletedFiles.wal,
          deletedFiles.shm,
          deletedFiles.journal,
          deletedFiles.meta,
          deletedFiles.brainDir,
          deletedFiles.annotation,
          deletedSecondaryFiles.db,
          deletedSecondaryFiles.brainDir,
          deletedSecondaryFiles.annotation,
        ]) {
          expect(yield* fs.exists(removedPath)).toBe(false);
        }
        expect(yield* fs.exists(activeFiles.db)).toBe(true);
        expect(yield* fs.exists(activeFiles.brainArtifact)).toBe(true);
        expect(yield* fs.exists(activeFiles.annotation)).toBe(true);
        expect(yield* fs.exists(otherProviderFiles.db)).toBe(true);
        expect(yield* fs.readFileString(summariesPath)).toBe("summaries");
      }).pipe(Effect.provide(testBaseLayer)),
  );

  it.effect(
    "cleans historical nativeThreadId sessions recorded in run_attempts after rollback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const db = yield* makeDbHelpers();
        const { profile } = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make("antigravity"),
        );

        const currentFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_A,
        });
        const rolledBackFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_B,
        });

        yield* db.insertThread({ threadId: "thread-rolled-back", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-current",
          threadId: "thread-rolled-back",
          nativeSessionId: SESSION_A,
        });
        yield* db.insertRunAndAttempt({
          runId: "run-1",
          attemptId: "attempt-1",
          threadId: "thread-rolled-back",
          providerThreadId: "pt-current",
          nativeThreadId: SESSION_B,
        });

        const result = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions: { isLive: () => Effect.succeed(false) },
        });

        expect(result).toEqual({ waiting: false, removedSessions: 2 });
        expect(yield* fs.exists(currentFiles.db)).toBe(false);
        expect(yield* fs.exists(rolledBackFiles.db)).toBe(false);
        expect(yield* fs.exists(rolledBackFiles.brainDir)).toBe(false);
        expect(yield* fs.exists(rolledBackFiles.annotation)).toBe(false);
      }).pipe(Effect.provide(testBaseLayer)),
  );

  it.effect(
    "defers cleanup when outbox is pending/running or session is live, then sweeps on Antigravity stop even with worktreeOnDelete disabled",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const db = yield* makeDbHelpers();
        const { profile } = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make("antigravity"),
        );

        const outboxFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_A,
        });
        const liveFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_B,
        });

        yield* db.insertThread({ threadId: "thread-outbox", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-outbox",
          threadId: "thread-outbox",
          nativeSessionId: SESSION_A,
        });
        yield* db.insertOutbox({
          effectId: "eff-pending",
          threadId: "thread-outbox",
          status: "pending",
        });

        yield* db.insertThread({ threadId: "thread-live", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-live",
          threadId: "thread-live",
          providerSessionId: "session-live-1",
          nativeSessionId: SESSION_B,
        });
        yield* db.insertProviderSession({
          sessionId: "session-live-1",
          threadId: "thread-live",
          status: "running",
        });

        let sessionLive = true;
        const providerSessions = {
          isLive: () => Effect.sync(() => sessionLive),
        };

        // Direct check: both pending outbox and live session block deletion and report waiting: true.
        const deferredResult = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions,
        });
        expect(deferredResult).toEqual({ waiting: true, removedSessions: 0 });
        expect(yield* fs.exists(outboxFiles.db)).toBe(true);
        expect(yield* fs.exists(liveFiles.db)).toBe(true);

        // Clear outbox to running first (still blocked), then succeeded (only live session remains blocked).
        yield* db.sql`UPDATE orchestration_v2_effect_outbox SET status = 'running' WHERE effect_id = 'eff-pending'`;
        const runningResult = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions,
        });
        expect(runningResult).toEqual({ waiting: true, removedSessions: 0 });
        expect(yield* fs.exists(outboxFiles.db)).toBe(true);

        yield* db.sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE effect_id = 'eff-pending'`;

        // Wire StorageCleanup with worktreeOnDelete: false and emit provider-session.updated(stopped).
        const startupSwept = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const stopEvent: OrchestrationV2DomainEvent = {
          id: EventId.make("event:agy-session-stopped"),
          type: "provider-session.updated",
          threadId: ThreadId.make("thread-live"),
          occurredAt: DateTime.makeUnsafe(NOW_MS),
          payload: {
            id: ProviderSessionId.make("session-live-1"),
            driver: ProviderDriverKind.make("antigravity"),
            providerInstanceId: ProviderInstanceId.make("antigravity"),
            status: "stopped",
            cwd: config.stateDir,
            model: null,
            capabilities: AcpProviderCapabilitiesV2,
            createdAt: DateTime.makeUnsafe(NOW_MS - 60_000),
            updatedAt: DateTime.makeUnsafe(NOW_MS),
            lastError: null,
          },
        };
        const settings = {
          ...DEFAULT_SERVER_SETTINGS,
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
            browserArtifactsAfterDays: null,
            logsAfterDays: null,
          },
        };
        const activated = yield* Deferred.make<void>();
        const events = Stream.fromEffect(Deferred.await(startupSwept)).pipe(
          Stream.flatMap(() => Stream.make(stopEvent)),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
          ),
        );
        const context = yield* Layer.build(StorageCleanup.layer).pipe(
          Effect.provideService(Settings.ServerSettingsService, {
            getSettings: Effect.succeed(settings),
            subscribeChanges: Effect.succeed(Stream.empty),
          } as unknown as Settings.ServerSettingsService["Service"]),
          Effect.provideService(ProjectStore.ProjectStoreV2, {
            list: () => Effect.succeed([]),
            listShells: () => Effect.succeed([]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
          Effect.provideService(ProjectionStore.ProjectionStoreV2, {
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
            getThreadWorktreePaths: () => Effect.succeed([]),
            getThreadShell: () => Effect.succeed(null),
          } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
            dispatch: () => Effect.succeed({ sequence: 0, storedEvents: [] }),
          } as unknown as ThreadManagement.ThreadManagementService["Service"]),
          Effect.provideService(GitWorkflowService.GitWorkflowService, {
            currentBranch: () => Effect.succeed(null),
          } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
          Effect.provideService(
            ProviderSessionManager.ProviderSessionManagerV2,
            providerSessions as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"],
          ),
          Effect.provideService(Orchestrator.OrchestratorV2, {
            streamDomainEvents: events,
          } as unknown as Orchestrator.OrchestratorV2["Service"]),
          Effect.provideService(GitManager.GitManager, {
            invalidateStatus: () => Effect.void,
          } as unknown as GitManager.GitManager["Service"]),
          Effect.provideService(TerminalManager.TerminalManager, {
            subscribeMetadata: () => Effect.succeed(() => {}),
          } as unknown as TerminalManager.TerminalManager["Service"]),
          Effect.provideService(ServerActivation, Deferred.await(activated)),
          Effect.provideService(TaskFolders.TaskFolders, {
            find: () => Effect.succeed(null),
            remove: () => Effect.succeed({ removed: [], kept: [] }),
          } as unknown as TaskFolders.TaskFolders["Service"]),
          Effect.provide(PendingSettleScripts.layer),
        );
        const service = Context.get(context, StorageCleanup.StorageCleanup);
        yield* Deferred.succeed(activated, undefined);

        // Wait for startup sweep to finish while sessionLive is still true.
        yield* service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* service.drain;
        // Outbox-cleared thread was removed during startup sweep; live session thread is still waiting.
        expect(yield* fs.exists(outboxFiles.db)).toBe(false);
        expect(yield* fs.exists(liveFiles.db)).toBe(true);

        // Session stops; StorageCleanup should re-sweep and remove liveFiles even with worktreeOnDelete: false.
        sessionLive = false;
        yield* Deferred.succeed(startupSwept, undefined);
        yield* Deferred.await(delivered);
        yield* service.drain;
        expect(yield* fs.exists(liveFiles.db)).toBe(false);
        expect(yield* fs.exists(liveFiles.brainDir)).toBe(false);
        expect(yield* fs.exists(liveFiles.annotation)).toBe(false);
      }).pipe(Effect.provide(testBaseLayer)),
  );

  it.effect(
    "preserves sessions shared with active threads or referenced via forkedFrom/lineage ancestors",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const db = yield* makeDbHelpers();
        const { profile } = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make("antigravity"),
        );

        const sharedFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_A,
        });
        const forkGrandparentFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_B,
        });
        const forkParentFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_C,
        });
        const lineageParentFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_D,
        });
        const unreferencedFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_E,
        });
        const sharedAttemptFiles = yield* createSessionFiles({
          profileDir: profile,
          sessionId: SESSION_F,
        });

        // Active thread shares SESSION_A directly and SESSION_F via run_attempts.
        yield* db.insertThread({ threadId: "thread-active-shared", deleted: false });
        yield* db.insertProviderThread({
          providerThreadId: "pt-active-shared",
          threadId: "thread-active-shared",
          nativeSessionId: SESSION_A,
        });
        yield* db.insertRunAndAttempt({
          runId: "run-active-shared",
          attemptId: "attempt-active-shared",
          threadId: "thread-active-shared",
          providerThreadId: "pt-active-shared",
          nativeThreadId: SESSION_F,
        });

        yield* db.insertThread({ threadId: "thread-deleted-shared", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-deleted-shared",
          threadId: "thread-deleted-shared",
          nativeSessionId: SESSION_A,
        });
        yield* db.insertRunAndAttempt({
          runId: "run-deleted-shared",
          attemptId: "attempt-deleted-shared",
          threadId: "thread-deleted-shared",
          providerThreadId: "pt-deleted-shared",
          nativeThreadId: SESSION_F,
        });

        // Active fork -> deleted intermediate fork parent -> deleted grandparent.
        yield* db.insertThread({ threadId: "thread-fork-grandparent", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-fork-grandparent",
          threadId: "thread-fork-grandparent",
          nativeSessionId: SESSION_B,
        });
        yield* db.insertThread({
          threadId: "thread-fork-parent",
          deleted: true,
          forkedFromThreadId: "thread-fork-grandparent",
        });
        yield* db.insertProviderThread({
          providerThreadId: "pt-fork-parent",
          threadId: "thread-fork-parent",
          nativeSessionId: SESSION_C,
        });
        yield* db.insertThread({
          threadId: "thread-fork-active",
          deleted: false,
          forkedFromThreadId: "thread-fork-parent",
        });

        // Active native subagent -> deleted lineage parent.
        yield* db.insertThread({ threadId: "thread-lineage-parent", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-lineage-parent",
          threadId: "thread-lineage-parent",
          nativeSessionId: SESSION_D,
        });
        yield* db.insertThread({
          threadId: "thread-subagent-active",
          deleted: false,
          parentThreadId: "thread-lineage-parent",
        });

        // Truly unreferenced deleted thread.
        yield* db.insertThread({ threadId: "thread-unreferenced", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-unreferenced",
          threadId: "thread-unreferenced",
          nativeSessionId: SESSION_E,
        });

        const result = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions: { isLive: () => Effect.succeed(false) },
        });

        expect(result).toEqual({ waiting: false, removedSessions: 1 });
        expect(yield* fs.exists(sharedFiles.db)).toBe(true);
        expect(yield* fs.exists(sharedAttemptFiles.db)).toBe(true);
        expect(yield* fs.exists(forkGrandparentFiles.db)).toBe(true);
        expect(yield* fs.exists(forkParentFiles.db)).toBe(true);
        expect(yield* fs.exists(lineageParentFiles.db)).toBe(true);
        expect(yield* fs.exists(unreferencedFiles.db)).toBe(false);
      }).pipe(Effect.provide(testBaseLayer)),
  );

  it.effect(
    "ignores non-UUIDv4 session IDs and skips symlinked directories or symlinked target files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const db = yield* makeDbHelpers();

        const outsideDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-outside-" });
        const outsideDb = path.join(outsideDir, `${SESSION_A}.db`);
        const outsideBrainFile = path.join(outsideDir, "secret.txt");
        const outsideTargetFile = path.join(outsideDir, "target.db");
        const outsideAnnotationFile = path.join(outsideDir, "target.pbtxt");
        yield* fs.writeFileString(outsideDb, "outside-db");
        yield* fs.writeFileString(outsideBrainFile, "outside-brain");
        yield* fs.writeFileString(outsideTargetFile, "outside-target");
        yield* fs.writeFileString(outsideAnnotationFile, "outside-annotation");

        // Case 1: Non-UUIDv4 session ID (`../escape`) attempting traversal.
        const escapeTarget = path.join(config.stateDir, "providers", "escape.db");
        yield* fs.makeDirectory(path.dirname(escapeTarget), { recursive: true });
        yield* fs.writeFileString(escapeTarget, "keep");
        yield* db.insertThread({ threadId: "thread-bad-id", deleted: true });
        yield* db.insertProviderThread({
          providerThreadId: "pt-bad-id",
          threadId: "thread-bad-id",
          nativeSessionId: "../escape",
        });

        if (symlinksSupported) {
          // Case 2: Symlinked conversations directory inside instance 1.
          const { profile: profileSymlinkDir } = yield* resolveAntigravityInstanceDirectories(
            config.stateDir,
            ProviderInstanceId.make("antigravity"),
          );
          const acpDir1 = path.join(profileSymlinkDir, "antigravity-acp");
          yield* fs.makeDirectory(acpDir1, { recursive: true });
          yield* fs.symlink(outsideDir, path.join(acpDir1, "conversations"));
          yield* fs.symlink(outsideDir, path.join(acpDir1, "brain"));
          yield* db.insertThread({ threadId: "thread-sym-dir", deleted: true });
          yield* db.insertProviderThread({
            providerThreadId: "pt-sym-dir",
            threadId: "thread-sym-dir",
            providerInstanceId: "antigravity",
            nativeSessionId: SESSION_A,
          });

          // Case 3: Symlinked target files inside instance 2.
          const { profile: profileSymlinkTarget } = yield* resolveAntigravityInstanceDirectories(
            config.stateDir,
            ProviderInstanceId.make("antigravity_2"),
          );
          const acpDir2 = path.join(profileSymlinkTarget, "antigravity-acp");
          yield* fs.makeDirectory(path.join(acpDir2, "conversations"), { recursive: true });
          yield* fs.makeDirectory(path.join(acpDir2, "brain"), { recursive: true });
          yield* fs.makeDirectory(path.join(acpDir2, "annotations"), { recursive: true });
          yield* fs.symlink(
            outsideTargetFile,
            path.join(acpDir2, "conversations", `${SESSION_B}.db`),
          );
          yield* fs.symlink(outsideDir, path.join(acpDir2, "brain", SESSION_B));
          yield* fs.symlink(
            outsideAnnotationFile,
            path.join(acpDir2, "annotations", `${SESSION_B}.pbtxt`),
          );
          yield* db.insertThread({ threadId: "thread-sym-file", deleted: true });
          yield* db.insertProviderThread({
            providerThreadId: "pt-sym-file",
            threadId: "thread-sym-file",
            providerInstanceId: "antigravity_2",
            nativeSessionId: SESSION_B,
          });
        }

        const result = yield* cleanDeletedAntigravitySessions({
          stateDir: config.stateDir,
          sql: db.sql,
          providerSessions: { isLive: () => Effect.succeed(false) },
        });

        expect(result).toEqual({ waiting: false, removedSessions: 0 });
        expect(yield* fs.readFileString(escapeTarget)).toBe("keep");
        expect(yield* fs.readFileString(outsideDb)).toBe("outside-db");
        expect(yield* fs.readFileString(outsideBrainFile)).toBe("outside-brain");
        expect(yield* fs.readFileString(outsideTargetFile)).toBe("outside-target");
        expect(yield* fs.readFileString(outsideAnnotationFile)).toBe("outside-annotation");
      }).pipe(Effect.provide(testBaseLayer)),
  );
});
