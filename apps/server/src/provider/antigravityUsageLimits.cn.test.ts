import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAuth } from "./AntigravityAuth.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import type { AntigravityAuthConfig } from "./antigravityAuthSupport.ts";
import {
  parseAntigravityUsageOutput,
  withAntigravityUsageLimits,
} from "./antigravityUsageLimits.cn.ts";

const PRO_FIXTURE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description:
            "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9949567914009094,
              reset_time: "2026-12-03T07:32:53Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9798272252082825,
              reset_time: "2026-11-26T12:32:53Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const ULTRA_FIXTURE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9946251511573792,
              reset_time: "2026-12-03T07:03:36Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9785006642341614,
              reset_time: "2026-11-26T12:03:36Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const INSTANCE_ID = ProviderInstanceId.make("antigravity");
const DRIVER = ProviderDriverKind.make("antigravity");
const CHECKED_AT = "2026-11-26T08:00:00.000Z";

function makeBaseSnapshot(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: DRIVER,
    enabled: true,
    installed: true,
    version: "1.5.15",
    status: "warning",
    auth: { status: "unknown", type: "oauth-personal", label: "Google account" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

interface SpawnOutcome {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
  readonly onKill?: () => Effect.Effect<void>;
}

const encode = (text: string) => new TextEncoder().encode(text);

const makeHarness = Effect.fn("AntigravityUsageLimitsTest.makeHarness")(function* (
  options: {
    readonly auth?: AntigravityAuthConfig;
    readonly enabled?: boolean;
    readonly initialSnapshot?: ServerProvider;
    readonly initialAwaitingFirstCheck?: boolean;
    readonly runBackgroundWork?: boolean;
    readonly createToken?: boolean;
    readonly failSymlink?: boolean;
    readonly missingInstallation?: boolean;
    readonly awaitReady?: Effect.Effect<void>;
    readonly withAuthController?: boolean;
    readonly onSpawn?: (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string | undefined;
      readonly env: Record<string, string | undefined>;
    }) => Effect.Effect<SpawnOutcome>;
  } = {},
) {
  const realFs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-ag-usage-test-" });
  const profileDirectory = path.join(root, "profile");
  const runtimeTempDirectory = path.join(root, "runtime-tmp");
  const acpDir = path.join(profileDirectory, "antigravity-acp");
  yield* realFs.makeDirectory(acpDir, { recursive: true });
  const sourceTokenPath = path.join(acpDir, "antigravity-oauth-token");
  if (options.createToken ?? true) {
    yield* realFs.writeFileString(sourceTokenPath, "oauth-token-placeholder");
  }

  const fsLayer = Layer.succeed(
    FileSystem.FileSystem,
    options.failSymlink
      ? FileSystem.FileSystem.of({
          ...realFs,
          symlink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "symlink",
              }),
            ),
        })
      : realFs,
  );

  const snapshotRef = yield* Ref.make(
    options.initialSnapshot ?? makeBaseSnapshot({ enabled: options.enabled ?? true }),
  );
  const awaitingRef = yield* Ref.make(options.initialAwaitingFirstCheck ?? false);
  const baseChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const applyUsageLimitsCalls = yield* Ref.make(0);
  const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER,
    packageName: null,
  });

  const baseManaged: ManagedServerProvider = {
    resolveMaintenance: () => Effect.succeed(maintenance),
    getSnapshot: Ref.get(snapshotRef),
    isAwaitingFirstCheck: Ref.get(awaitingRef),
    refresh: Ref.get(snapshotRef),
    applyUsageLimits: () => Ref.update(applyUsageLimitsCalls, (n) => n + 1),
    get streamChanges() {
      return Stream.fromPubSub(baseChangesPubSub);
    },
  };

  const spawnCalls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
    readonly env: Record<string, string | undefined>;
  }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      const rawEnv = command.options.env ?? {};
      const env = Object.fromEntries(
        Object.entries(rawEnv).map(([k, v]) => [k, Redacted.isRedacted(v) ? Redacted.value(v) : v]),
      );
      const record = {
        command: command.command,
        args: command.args.map(String),
        cwd: command.options.cwd,
        env,
      };
      spawnCalls.push(record);
      const outcome = options.onSpawn
        ? yield* options.onSpawn(record)
        : { stdout: PRO_FIXTURE, code: 0 };
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1001),
        exitCode: outcome.hang
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(outcome.code ?? 0)),
        isRunning: Effect.succeed(outcome.hang ?? false),
        kill: () => outcome.onKill?.() ?? Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: outcome.stdout ? Stream.make(encode(outcome.stdout)) : Stream.empty,
        stderr: outcome.stderr ? Stream.make(encode(outcome.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const authFlow = options.withAuthController
    ? yield* makeAntigravityAuth({
        instanceId: INSTANCE_ID,
        makeRuntime: () => Effect.die("unused"),
        onAuthenticated: () => Effect.void,
        onSignedOut: Effect.void,
      })
    : undefined;

  const probeSettledQueue = yield* Queue.unbounded<void>();
  const installationLayer = Layer.succeed(
    AntigravityInstallation.AntigravityInstallation,
    AntigravityInstallation.AntigravityInstallation.of({
      managedDirectory: root,
      resolve: () =>
        options.missingInstallation
          ? Effect.fail(
              new AntigravityInstallation.AntigravityInstallationError({
                operation: "resolve",
                detail: "Not installed.",
              }),
            )
          : Effect.succeed({
              executablePath: "/opt/antigravity/antigravity",
              source: "managed",
              version: "1.5.15",
              managedVersionDirectory: root,
            }),
      acquire: () =>
        options.missingInstallation
          ? Effect.fail(
              new AntigravityInstallation.AntigravityInstallationError({
                operation: "resolve",
                detail: "Not installed.",
              }),
            )
          : Effect.acquireRelease(
              Effect.succeed({
                executablePath: "/opt/antigravity/antigravity",
                source: "managed" as const,
                version: "1.5.15",
                managedVersionDirectory: root,
              }),
              () => Queue.offer(probeSettledQueue, undefined).pipe(Effect.asVoid),
            ),
      compatibility: () => Effect.undefined,
      start: Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      state: Effect.die("unused"),
      changes: Stream.empty,
      checkForUpdate: Effect.void,
      remove: () => Effect.void,
    }),
  );

  const hostLayer = Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: root,
        baseDir: root,
        stateDir: root,
        providerStatusCacheDir: root,
        attachmentsDir: root,
      },
      settings: {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(options.runBackgroundWork ?? false),
      ...(options.awaitReady ? { awaitServerReady: options.awaitReady } : {}),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
      compatibility: () => Effect.undefined,
    }),
  );

  const baseInstance: ProviderInstance = {
    instanceId: INSTANCE_ID,
    driverKind: DRIVER,
    continuationIdentity: {
      driverKind: DRIVER,
      continuationKey: "antigravity:instance:antigravity",
    },
    displayName: "Antigravity",
    enabled: options.enabled ?? true,
    snapshot: baseManaged,
    snapshotForCwd: () => Ref.get(snapshotRef).pipe(Effect.map((s) => ({ ...s, skills: [] }))),
    orchestrationAdapter: {} as ProviderAdapter.ProviderAdapterV2["Service"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    ...(authFlow ? { auth: authFlow.controller } : {}),
  };

  const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
  const combinedLayer = Layer.mergeAll(installationLayer, hostLayer, spawnerLayer, fsLayer);

  const wrapped = yield* withAntigravityUsageLimits(baseInstance, {
    auth: options.auth ?? {
      authMethod: "oauth-personal",
      apiKey: "",
      gcpProject: "",
      gcpLocation: "",
    },
    binaryPath: undefined,
    profileDirectory,
    runtimeTempDirectory,
    processEnvironment: { PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:7890" },
    ...(authFlow ? { withProcess: authFlow.withProcess } : {}),
  }).pipe(Effect.provide(combinedLayer));

  const emitBaseSnapshot = (next: ServerProvider, awaiting = false) =>
    Ref.set(awaitingRef, awaiting).pipe(
      Effect.andThen(Ref.set(snapshotRef, next)),
      Effect.andThen(PubSub.publish(baseChangesPubSub, next)),
    );

  return {
    wrapped,
    profileDirectory,
    runtimeTempDirectory,
    sourceTokenPath,
    spawnCalls,
    applyUsageLimitsCalls,
    emitBaseSnapshot,
    authFlow,
    awaitProbeSettled: Queue.take(probeSettledQueue).pipe(Effect.andThen(Effect.yieldNow)),
  };
});

describe("parseAntigravityUsageOutput", () => {
  it("maps Pro and Ultra CLI outputs with Gemini first, modelScope only, and 1970 reset omitted", () => {
    const nowMs = Date.parse("2026-11-26T08:00:00.000Z");
    const pro = parseAntigravityUsageOutput({ stdout: PRO_FIXTURE, checkedAt: CHECKED_AT, nowMs });
    expect(pro.ok).toBe(true);
    if (!pro.ok) return;

    expect(pro.limits.checkedAt).toBe(CHECKED_AT);
    expect(pro.limits.credentialFingerprint).toBeUndefined();
    expect(pro.limits.windows.map((w) => w.id)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
    ]);
    expect(pro.limits.windows).toEqual([
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        modelScope: { kind: "patterns", includePrefixes: ["gemini-"] },
        usedPercent: (1 - 0.9798272252082825) * 100,
        windowDurationMins: 300,
        resetsAt: "2026-11-26T12:32:53.000Z",
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        modelScope: { kind: "patterns", includePrefixes: ["gemini-"] },
        usedPercent: (1 - 0.9949567914009094) * 100,
        windowDurationMins: 10_080,
        resetsAt: "2026-12-03T07:32:53.000Z",
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT (shared) · 5-hour",
        modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        modelScope: { kind: "patterns", includePrefixes: ["claude-", "gpt-"] },
        usedPercent: 0,
        windowDurationMins: 10_080,
      },
    ]);
    for (const window of pro.limits.windows) {
      expect(window.modelIds).toBeUndefined();
      expect(window.label.toLowerCase()).not.toContain("argon");
      expect(window.label.toLowerCase()).not.toContain("carbon");
    }

    const ultra = parseAntigravityUsageOutput({
      stdout: ULTRA_FIXTURE,
      checkedAt: CHECKED_AT,
      nowMs,
    });
    expect(ultra.ok).toBe(true);
    if (!ultra.ok) return;
    expect(ultra.limits.windows[0]?.resetsAt).toBe("2026-11-26T12:03:36.000Z");
    expect(ultra.limits.windows[1]?.resetsAt).toBe("2026-12-03T07:03:36.000Z");
  });

  it("drops past resets, clamps percentages, preserves unknown windows/ids, and rejects empty/bad payloads", () => {
    const nowMs = Date.parse("2026-11-26T12:00:00.000Z");
    const result = parseAntigravityUsageOutput({
      checkedAt: "2026-11-26T12:00:00.000Z",
      nowMs,
      stdout: JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-argon-5h",
                    window: "5h",
                    remaining_fraction: -0.2,
                    reset_time: "2026-11-26T11:59:00Z",
                  },
                  {
                    id: "gemini-quota",
                    window: "monthly",
                    remaining_fraction: 1.4,
                    reset_time: "1970-06-01T00:00:00Z",
                  },
                ],
              },
              {
                name: "Custom",
                buckets: [
                  {
                    id: "custom-5h",
                    window: "5h",
                    remaining_fraction: 0.5,
                    reset_time: "2026-11-26T15:00:00Z",
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.limits.windows).toEqual([
      {
        id: "gemini-argon-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        modelScope: { kind: "patterns", includePrefixes: ["gemini-"] },
        usedPercent: 100,
        windowDurationMins: 300,
      },
      {
        id: "gemini-quota",
        kind: "other",
        label: "Gemini · monthly",
        modelScope: { kind: "patterns", includePrefixes: ["gemini-"] },
        usedPercent: 0,
      },
      {
        id: "custom-5h",
        kind: "session",
        label: "Custom · 5-hour",
        usedPercent: 50,
        windowDurationMins: 300,
        resetsAt: "2026-11-26T15:00:00.000Z",
      },
    ]);

    expect(parseAntigravityUsageOutput({ stdout: "{bad", checkedAt: CHECKED_AT }).ok).toBe(false);
    expect(
      parseAntigravityUsageOutput({
        stdout: JSON.stringify({ status: "ERROR", command: { data: { groups: [] } } }),
        checkedAt: CHECKED_AT,
      }).ok,
    ).toBe(false);
    expect(
      parseAntigravityUsageOutput({
        stdout: JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } }),
        checkedAt: CHECKED_AT,
      }).ok,
    ).toBe(false);
  });
});

const subscribeSnapshots = Effect.fn("test.subscribeSnapshots")(function* (
  stream: Stream.Stream<ServerProvider>,
  predicate: (snapshot: ServerProvider) => boolean = () => true,
) {
  const queue = yield* Queue.unbounded<ServerProvider>();
  yield* stream.pipe(
    Stream.filter(predicate),
    Stream.runForEach((snapshot) => Queue.offer(queue, snapshot)),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return Queue.take(queue);
});

const testLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.layer(testLayer)("withAntigravityUsageLimits", (it) => {
  it.effect(
    "overlays usage onto snapshots without calling applyUsageLimits, sets isolated HOME/symlink, and skips emission while awaiting first check",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(CHECKED_AT));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ready = yield* Deferred.make<void>();
        const spawned = yield* Deferred.make<void>();

        const h = yield* makeHarness({
          initialAwaitingFirstCheck: true,
          awaitReady: Deferred.await(ready),
          onSpawn: () =>
            Deferred.succeed(spawned, undefined).pipe(Effect.as({ stdout: PRO_FIXTURE, code: 0 })),
        });

        const emitted: ServerProvider[] = [];
        yield* h.wrapped.snapshot.streamChanges.pipe(
          Stream.runForEach((s) => Effect.sync(() => emitted.push(s))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        // While awaiting first check, usage refresh must not emit placeholder snapshots.
        yield* h.wrapped.snapshot.refreshUsage!;
        yield* Deferred.await(spawned);
        expect(emitted).toEqual([]);
        expect(yield* Ref.get(h.applyUsageLimitsCalls)).toBe(0);

        // Even before base emits, getSnapshot/snapshotForCwd still overlay held limits.
        const snapshotBeforeFirstCheck = yield* h.wrapped.snapshot.getSnapshot;
        expect(snapshotBeforeFirstCheck.usageLimits?.windows).toHaveLength(4);
        expect((yield* h.wrapped.snapshotForCwd!("/workspace")).usageLimits?.windows).toHaveLength(
          4,
        );
        expect(yield* h.wrapped.snapshot.isAwaitingFirstCheck!).toBe(true);

        // Verify spawn env, args, symlink, and truncated log file.
        expect(h.spawnCalls).toHaveLength(1);
        const call = h.spawnCalls[0]!;
        const usageHome = path.join(h.profileDirectory, "t3-usage-home");
        expect(call.args).toEqual([
          "-p",
          "/usage",
          "--output-format",
          "json",
          "--print-timeout",
          "25s",
          "--log-file",
          path.join(usageHome, "usage.log"),
        ]);
        expect(call.env.HOME).toBe(usageHome);
        expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
        expect(call.env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
        expect(call.env.BROWSER).toBe("");
        expect(yield* fs.exists(path.join(usageHome, "usage.log"))).toBe(true);
        const linkPath = path.join(
          usageHome,
          ".gemini",
          "antigravity-cli",
          "antigravity-oauth-token",
        );
        expect(path.resolve(path.dirname(linkPath), yield* fs.readLink(linkPath))).toBe(
          path.resolve(h.sourceTokenPath),
        );

        // Completing first check emits snapshot with usageLimits, and subsequent usage signal emits too.
        const takeUsageSnapshot = yield* subscribeSnapshots(
          h.wrapped.snapshot.streamChanges,
          (s) => s.usageLimits !== undefined,
        );
        yield* Deferred.succeed(ready, undefined);
        yield* h.emitBaseSnapshot(makeBaseSnapshot({ status: "warning" }), false);
        const afterFirstCheck = yield* takeUsageSnapshot;
        expect(afterFirstCheck.usageLimits?.windows[0]?.id).toBe("gemini-5h");

        yield* TestClock.adjust("2 minutes");
        yield* h.wrapped.snapshot.refreshUsage!;
        const afterUsageSignal = yield* takeUsageSnapshot;
        expect(afterUsageSignal.usageLimits?.checkedAt).toBe("2026-11-26T08:02:00.000Z");
      }),
  );

  it.effect(
    "retains last good reading on failure, retries in 2m then 10m, and marks unavailable after 1 hour",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-26T08:00:00.000Z"));
        const ready = yield* Deferred.make<void>();
        let failNext = false;
        const spawned = yield* Ref.make(0);
        let nextSpawnGate = yield* Deferred.make<void>();

        const h = yield* makeHarness({
          runBackgroundWork: true,
          awaitReady: Deferred.await(ready),
          onSpawn: () =>
            Effect.gen(function* () {
              yield* Ref.update(spawned, (n) => n + 1);
              yield* Deferred.succeed(nextSpawnGate, undefined);
              return failNext
                ? { code: 1, stderr: "network error\nmore details" }
                : { stdout: PRO_FIXTURE, code: 0 };
            }),
        });

        const nextProbe = () =>
          Effect.gen(function* () {
            yield* Deferred.await(nextSpawnGate);
            nextSpawnGate = yield* Deferred.make<void>();
          });

        const takeUsageSnapshot = yield* subscribeSnapshots(
          h.wrapped.snapshot.streamChanges,
          (s) => s.usageLimits !== undefined,
        );

        // Trigger initial probe at t=0 and await completion before advancing TestClock.
        yield* Deferred.succeed(ready, undefined);
        const firstEmitted = yield* takeUsageSnapshot;
        yield* nextProbe();
        yield* h.awaitProbeSettled;
        expect(yield* Ref.get(spawned)).toBe(1);
        const initialLimits = firstEmitted.usageLimits;
        expect(initialLimits?.checkedAt).toBe("2026-11-26T08:00:00.000Z");
        expect(initialLimits?.unavailable).toBeUndefined();

        // At t=10m, probe fails -> retains original checkedAt & windows.
        failNext = true;
        yield* TestClock.adjust("10 minutes");
        yield* nextProbe();
        yield* h.awaitProbeSettled;
        expect(yield* Ref.get(spawned)).toBe(2);
        const afterFirstFail = (yield* h.wrapped.snapshot.getSnapshot).usageLimits;
        expect(afterFirstFail).toEqual(initialLimits);

        // Retries once after 2 minutes (t=12m).
        yield* TestClock.adjust("2 minutes");
        yield* nextProbe();
        yield* h.awaitProbeSettled;
        expect(yield* Ref.get(spawned)).toBe(3);
        expect((yield* h.wrapped.snapshot.getSnapshot).usageLimits).toEqual(initialLimits);

        // Does not retry after another 2 minutes (t=14m); returns to 10-minute cadence (t=22m).
        yield* TestClock.adjust("2 minutes");
        expect(yield* Ref.get(spawned)).toBe(3);
        yield* TestClock.adjust("8 minutes");
        yield* nextProbe();
        yield* h.awaitProbeSettled;
        expect(yield* Ref.get(spawned)).toBe(4);

        // Advance through 32m, 42m, 52m, and 62m (>1h since t=0) -> marks unavailable.
        for (const _ of [1, 2, 3, 4]) {
          yield* TestClock.adjust("10 minutes");
          yield* nextProbe();
          yield* h.awaitProbeSettled;
        }
        expect(yield* Ref.get(spawned)).toBe(8);
        const unavailableEmitted = yield* takeUsageSnapshot;
        expect(unavailableEmitted.usageLimits?.windows).toEqual([]);
        expect(unavailableEmitted.usageLimits?.unavailable?.reason).toBe("probeFailed");
      }),
  );

  it.effect(
    "respects skip conditions (unknown runs, unauthenticated/api-key/disabled/missing-token/symlink-unsupported skip)",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(CHECKED_AT));

        // unauthenticated skips
        const unauth = yield* makeHarness({
          initialSnapshot: makeBaseSnapshot({ auth: { status: "unauthenticated" } }),
        });
        yield* Effect.yieldNow;
        expect(unauth.spawnCalls).toHaveLength(0);
        expect((yield* unauth.wrapped.snapshot.getSnapshot).usageLimits).toBeUndefined();

        // non-Google auth skips
        const apiKey = yield* makeHarness({
          auth: { authMethod: "gemini-api-key", apiKey: "k", gcpProject: "", gcpLocation: "" },
        });
        yield* Effect.yieldNow;
        expect(apiKey.spawnCalls).toHaveLength(0);
        expect((yield* apiKey.wrapped.snapshot.getSnapshot).usageLimits).toBeUndefined();

        // disabled skips
        const disabled = yield* makeHarness({ enabled: false });
        yield* Effect.yieldNow;
        expect(disabled.spawnCalls).toHaveLength(0);

        // missing token skips
        const noToken = yield* makeHarness({ createToken: false });
        yield* Effect.yieldNow;
        expect(noToken.spawnCalls).toHaveLength(0);

        // symlink failure skips without copying token
        const badSymlink = yield* makeHarness({ failSymlink: true });
        yield* Effect.yieldNow;
        expect(badSymlink.spawnCalls).toHaveLength(0);
      }),
  );

  it.effect(
    "enforces 30s hard timeout, 60s cache on refresh, refreshUsage, and symlink repair",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(CHECKED_AT));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ready = yield* Deferred.make<void>();
        let killed = 0;
        let hangNext = false;
        let nextSpawnGate = yield* Deferred.make<void>();
        let killGate = yield* Deferred.make<void>();

        const h = yield* makeHarness({
          awaitReady: Deferred.await(ready),
          onSpawn: () =>
            Deferred.succeed(nextSpawnGate, undefined).pipe(
              Effect.as(
                hangNext
                  ? {
                      hang: true,
                      onKill: () =>
                        Effect.sync(() => {
                          killed += 1;
                        }).pipe(
                          Effect.andThen(Deferred.succeed(killGate, undefined)),
                          Effect.asVoid,
                        ),
                    }
                  : { stdout: ULTRA_FIXTURE, code: 0 },
              ),
            ),
        });

        const takeUsageSnapshot = yield* subscribeSnapshots(
          h.wrapped.snapshot.streamChanges,
          (s) => s.usageLimits !== undefined,
        );
        yield* Deferred.succeed(ready, undefined);
        yield* takeUsageSnapshot;
        yield* Deferred.await(nextSpawnGate);
        nextSpawnGate = yield* Deferred.make<void>();
        expect(h.spawnCalls).toHaveLength(1);

        // Manual refresh within 60s uses cache.
        yield* h.wrapped.snapshot.refresh;
        yield* Effect.yieldNow;
        expect(h.spawnCalls).toHaveLength(1);

        // Replace symlink with a plain file and verify next run rebuilds the symlink.
        const linkPath = path.join(
          h.profileDirectory,
          "t3-usage-home",
          ".gemini",
          "antigravity-cli",
          "antigravity-oauth-token",
        );
        yield* fs.remove(linkPath, { force: true });
        yield* fs.writeFileString(linkPath, "stale-regular-file");

        // After 61s, manual refresh spawns again (and hangs -> killed at 30s).
        yield* TestClock.adjust("61 seconds");
        hangNext = true;
        yield* h.wrapped.snapshot.refresh;
        yield* Deferred.await(nextSpawnGate);
        nextSpawnGate = yield* Deferred.make<void>();
        expect(h.spawnCalls).toHaveLength(2);
        expect(path.resolve(path.dirname(linkPath), yield* fs.readLink(linkPath))).toBe(
          path.resolve(h.sourceTokenPath),
        );
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(killGate);
        yield* h.awaitProbeSettled;
        killGate = yield* Deferred.make<void>();
        expect(killed).toBe(1);

        // refreshUsage forces read immediately even inside 60s.
        hangNext = false;
        yield* h.wrapped.snapshot.refreshUsage!;
        expect(h.spawnCalls).toHaveLength(3);
      }),
  );

  it.effect(
    "interrupts in-flight probe on logout via authFlow.withProcess and clears cached limits",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(CHECKED_AT));
        const ready = yield* Deferred.make<void>();
        let killed = 0;
        let hangProbe = false;
        const hangStarted = yield* Deferred.make<void>();
        const hangKilled = yield* Deferred.make<void>();

        const h = yield* makeHarness({
          withAuthController: true,
          awaitReady: Deferred.await(ready),
          onSpawn: () =>
            Effect.gen(function* () {
              if (!hangProbe) return { stdout: PRO_FIXTURE, code: 0 };
              yield* Deferred.succeed(hangStarted, undefined);
              return {
                hang: true,
                onKill: () =>
                  Effect.sync(() => {
                    killed += 1;
                  }).pipe(Effect.andThen(Deferred.succeed(hangKilled, undefined)), Effect.asVoid),
              };
            }),
        });

        const takeUsageSnapshot = yield* subscribeSnapshots(
          h.wrapped.snapshot.streamChanges,
          (s) => s.usageLimits !== undefined,
        );
        yield* Deferred.succeed(ready, undefined);
        yield* takeUsageSnapshot;
        yield* h.awaitProbeSettled;
        expect((yield* h.wrapped.snapshot.getSnapshot).usageLimits?.windows).toHaveLength(4);

        hangProbe = true;
        yield* TestClock.adjust("61 seconds");
        const refreshFiber = yield* h.wrapped.snapshot.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(hangStarted);

        yield* h.emitBaseSnapshot(makeBaseSnapshot({ auth: { status: "unauthenticated" } }));
        yield* Deferred.await(hangKilled);
        yield* h.awaitProbeSettled;
        yield* Fiber.await(refreshFiber);
        expect((yield* h.wrapped.snapshot.getSnapshot).usageLimits).toBeUndefined();
        expect(killed).toBe(1);
      }),
  );

  it.effect("enforces per-instance single-flight for concurrent probes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(CHECKED_AT));
      const ready = yield* Deferred.make<void>();
      const spawnStarted = yield* Deferred.make<void>();
      const releaseSpawn = yield* Deferred.make<void>();

      const h = yield* makeHarness({
        awaitReady: Deferred.await(ready),
        onSpawn: () =>
          Deferred.succeed(spawnStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSpawn)),
            Effect.as({ stdout: PRO_FIXTURE, code: 0 }),
          ),
      });

      const first = yield* h.wrapped.snapshot.refreshUsage!.pipe(Effect.forkChild);
      yield* Deferred.await(spawnStarted);
      // A second concurrent refresh shares the in-flight probe instead of spawning a second CLI.
      const second = yield* h.wrapped.snapshot.refresh.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(h.spawnCalls).toHaveLength(1);

      yield* Deferred.succeed(releaseSpawn, undefined);
      yield* Fiber.await(first);
      yield* Fiber.await(second);
      expect(h.spawnCalls).toHaveLength(1);
    }),
  );
});
