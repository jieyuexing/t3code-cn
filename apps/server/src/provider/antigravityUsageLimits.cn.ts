import type {
  ProviderAuthState,
  ProviderSetupError,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageWindowModelScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { AntigravityAuth } from "./AntigravityAuth.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import {
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  type AntigravityAuthConfig,
  type AntigravityProfile,
} from "./antigravityAuthSupport.ts";

const REFRESH_INTERVAL_MS = 10 * 60_000;
const RETRY_SOON_DELAY_MS = 2 * 60_000;
const MANUAL_REFRESH_CACHE_MS = 60_000;
const STALE_LIMITS_MAX_AGE_MS = 60 * 60_000;
const CLI_HARD_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 4_096;
const EPOCH_1971_UTC_MS = 31_536_000_000;
const UNAVAILABLE_MESSAGE = "Could not read Antigravity usage limits.";
const TOKEN_FILE_NAME = "antigravity-oauth-token";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const GEMINI_MODEL_SCOPE: UsageWindowModelScope = {
  kind: "patterns",
  includePrefixes: ["gemini-"],
};

const THIRD_PARTY_MODEL_SCOPE: UsageWindowModelScope = {
  kind: "patterns",
  includePrefixes: ["claude-", "gpt-"],
};

export type AntigravityUsageParseResult =
  | { readonly ok: true; readonly limits: ServerProviderUsageLimits }
  | { readonly ok: false; readonly reason: string };

interface UsageState {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly lastSuccessAtMs: number | undefined;
  readonly consecutiveFailures: number;
}

const INITIAL_USAGE_STATE: UsageState = {
  limits: undefined,
  lastSuccessAtMs: undefined,
  consecutiveFailures: 0,
};

function groupRank(id: string): number {
  if (id.startsWith("gemini-")) return 0;
  if (id.startsWith("3p-")) return 1;
  return 2;
}

function parseValidResetTime(value: unknown, nowMs: number | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs) || parsedMs < EPOCH_1971_UTC_MS) return undefined;
  if (nowMs !== undefined && parsedMs <= nowMs) return undefined;
  const dt = DateTime.make(parsedMs);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function classifyWindow(rawWindow: string): {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins?: number;
  readonly suffix: string;
} {
  if (rawWindow === "5h") {
    return { kind: "session", windowDurationMins: 300, suffix: "5-hour" };
  }
  if (rawWindow === "weekly") {
    return { kind: "weekly", windowDurationMins: 10_080, suffix: "Weekly" };
  }
  return { kind: "other", suffix: rawWindow || "Other" };
}

function firstSanitizedLine(text: string): string {
  const first = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return "Antigravity /usage failed.";
  if (/https:\/\/accounts\.google\.com\//iu.test(first)) {
    return "Antigravity CLI requested interactive Google sign-in.";
  }
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

export function parseAntigravityUsageOutput(input: {
  readonly stdout: string;
  readonly checkedAt: string;
  readonly nowMs?: number;
}): AntigravityUsageParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return { ok: false, reason: "Invalid JSON output from Antigravity /usage." };
  }
  if (!Predicate.isObject(parsed)) {
    return { ok: false, reason: "Antigravity /usage returned a non-object JSON payload." };
  }
  if (parsed.status !== "SUCCESS") {
    return {
      ok: false,
      reason: `Antigravity /usage returned status ${String(parsed.status ?? "unknown")}.`,
    };
  }
  const command = Predicate.isObject(parsed.command) ? parsed.command : undefined;
  const data = command && Predicate.isObject(command.data) ? command.data : undefined;
  const groups = data && Array.isArray(data.groups) ? data.groups : undefined;
  if (!groups) {
    return { ok: false, reason: "Antigravity /usage output contained no usage groups." };
  }

  const checkedAtMs = Date.parse(input.checkedAt);
  const nowMs = input.nowMs ?? (Number.isFinite(checkedAtMs) ? checkedAtMs : undefined);
  const byId = new Map<string, ServerProviderUsageWindow>();

  for (const group of groups) {
    if (!Predicate.isObject(group) || !Array.isArray(group.buckets)) continue;
    const groupName = typeof group.name === "string" ? group.name.trim() : "";
    for (const bucket of group.buckets) {
      if (!Predicate.isObject(bucket)) continue;
      const id = typeof bucket.id === "string" ? bucket.id.trim() : "";
      const remaining = bucket.remaining_fraction;
      if (!id || typeof remaining !== "number" || !Number.isFinite(remaining)) continue;

      const rawWindow = typeof bucket.window === "string" ? bucket.window.trim() : "";
      const classified = classifyWindow(rawWindow);
      const isGemini = id.startsWith("gemini-") || /^gemini\b/iu.test(groupName);
      const isThirdParty =
        !isGemini && (id.startsWith("3p-") || /\b(?:claude|gpt)\b/iu.test(groupName));
      const groupPrefix = isGemini
        ? "Gemini"
        : isThirdParty
          ? "Claude & GPT (shared)"
          : groupName.replace(/\b(?:argon|carbon)\b/giu, "").trim() || id;
      const modelScope = isGemini
        ? GEMINI_MODEL_SCOPE
        : isThirdParty
          ? THIRD_PARTY_MODEL_SCOPE
          : undefined;
      const resetsAt = parseValidResetTime(bucket.reset_time, nowMs);

      byId.set(id, {
        id,
        kind: classified.kind,
        label: `${groupPrefix} · ${classified.suffix}`,
        ...(modelScope !== undefined ? { modelScope } : {}),
        usedPercent: clampPercent((1 - remaining) * 100),
        ...(classified.windowDurationMins !== undefined
          ? { windowDurationMins: classified.windowDurationMins }
          : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      });
    }
  }

  if (byId.size === 0) {
    return {
      ok: false,
      reason: "Antigravity /usage output contained no recognized quota buckets.",
    };
  }

  const windows = [...byId.values()].toSorted(
    (left, right) =>
      groupRank(left.id) - groupRank(right.id) ||
      left.id
        .replace(/-(?:5h|weekly)$/u, "")
        .localeCompare(right.id.replace(/-(?:5h|weekly)$/u, "")) ||
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );

  return {
    ok: true,
    limits: {
      checkedAt: input.checkedAt,
      windows,
    },
  };
}

function applyFailureToUsageState(input: {
  readonly state: UsageState;
  readonly nowMs: number;
  readonly nowIso: string;
}): { readonly next: UsageState; readonly changed: boolean } {
  const { state, nowMs, nowIso } = input;
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (
    state.lastSuccessAtMs !== undefined &&
    nowMs - state.lastSuccessAtMs <= STALE_LIMITS_MAX_AGE_MS &&
    state.limits !== undefined &&
    !state.limits.unavailable
  ) {
    return {
      next: { ...state, consecutiveFailures },
      changed: false,
    };
  }
  const unavailable = makeUnavailableUsageLimits({
    checkedAt: nowIso,
    reason: "probeFailed",
    message: UNAVAILABLE_MESSAGE,
  });
  const changed =
    state.limits === undefined ||
    state.limits.unavailable?.reason !== unavailable.unavailable?.reason ||
    state.limits.unavailable?.message !== unavailable.unavailable?.message ||
    state.limits.windows.length > 0;
  return {
    next: {
      limits: changed ? unavailable : state.limits,
      lastSuccessAtMs: state.lastSuccessAtMs,
      consecutiveFailures,
    },
    changed,
  };
}

function nextUsageProbeDelayMs(consecutiveFailures: number): number {
  return consecutiveFailures === 1 ? RETRY_SOON_DELAY_MS : REFRESH_INTERVAL_MS;
}

export interface AntigravityUsageLimitsOptions {
  readonly auth: AntigravityAuthConfig;
  readonly binaryPath: string | undefined;
  readonly profileDirectory: string;
  readonly runtimeTempDirectory: string;
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly withProcess?: AntigravityAuth["withProcess"];
}

function isStartProcessBusyError(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.findErrorOption(cause);
  return (
    Option.isSome(error) &&
    Predicate.isObject(error.value) &&
    error.value._tag === "ProviderSetupError" &&
    error.value.operation === "startProcess"
  );
}

export const withAntigravityUsageLimits = Effect.fn("withAntigravityUsageLimits")(function* (
  instance: ProviderInstance,
  options: AntigravityUsageLimitsOptions,
): Effect.fn.Return<
  ProviderInstance,
  never,
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost.ProviderHost;
  const installation = yield* AntigravityInstallation.AntigravityInstallation;
  const platform = yield* HostProcess.Platform;
  const instanceScope = yield* Scope.Scope;

  const baseSnapshot = instance.snapshot;
  const supportsQuota = antigravityAuthUsesBrowser(options.auth.authMethod);
  const usageStateRef = yield* Ref.make<UsageState>(INITIAL_USAGE_STATE);
  const inFlightRef = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const activeRunFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const firstCheckDone = yield* Deferred.make<void>();
  const scheduleResetQueue = yield* Queue.sliding<void>(1);
  const mergedChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );

  const sourceTokenPath = path.join(options.profileDirectory, "antigravity-acp", TOKEN_FILE_NAME);
  const usageHome = path.join(options.profileDirectory, "t3-usage-home");
  const usageLogPath = path.join(usageHome, "usage.log");
  const usageCliDir = path.join(usageHome, ".gemini", "antigravity-cli");
  const symlinkTokenPath = path.join(usageCliDir, TOKEN_FILE_NAME);

  const stripUsageLimits = <S extends ServerProvider>(snapshot: S): S => {
    if (snapshot.usageLimits === undefined) return snapshot;
    const { usageLimits: _dropped, ...rest } = snapshot;
    return rest as S;
  };

  const overlaySnapshot = Effect.fnUntraced(function* <S extends ServerProvider>(
    snapshot: S,
  ): Effect.fn.Return<S> {
    if (!supportsQuota || !snapshot.enabled || snapshot.auth.status === "unauthenticated") {
      return stripUsageLimits(snapshot);
    }
    const awaiting = yield* baseSnapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
    if (!awaiting && !snapshot.installed) {
      return stripUsageLimits(snapshot);
    }
    const { limits } = yield* Ref.get(usageStateRef);
    if (limits === undefined) return snapshot;
    return { ...snapshot, usageLimits: limits };
  });

  const getWrappedSnapshot = baseSnapshot.getSnapshot.pipe(Effect.flatMap(overlaySnapshot));

  const publishUsageChanged = Effect.gen(function* () {
    const awaiting = yield* baseSnapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
    if (awaiting) return;
    yield* PubSub.publish(mergedChangesPubSub, yield* getWrappedSnapshot);
  });

  const clearUsageState = Effect.fn("AntigravityUsageLimits.clear")(function* () {
    const previous = yield* Ref.getAndSet(usageStateRef, INITIAL_USAGE_STATE);
    if (previous.limits !== undefined) {
      yield* publishUsageChanged;
    }
  });

  const interruptActiveRun = Effect.fnUntraced(function* () {
    const fiber = yield* Ref.getAndSet(activeRunFiberRef, null);
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const runWithAuthGuard = <A, E, R>(
    stop: Effect.Effect<void>,
    task: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope> =>
    options.withProcess ? options.withProcess(stop, task) : task;

  const ensureUsageTokenSymlink = Effect.fn("AntigravityUsageLimits.ensureSymlink")(function* () {
    const tokenStat = yield* fs.stat(sourceTokenPath).pipe(Effect.option);
    if (Option.isNone(tokenStat) || tokenStat.value.type !== "File") {
      return "missing-token" as const;
    }
    yield* fs.makeDirectory(usageHome, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(usageCliDir, { recursive: true, mode: 0o700 });
    const expectedTarget = path.resolve(sourceTokenPath);
    const existingTarget = yield* fs.readLink(symlinkTokenPath).pipe(
      Effect.map((value) => path.resolve(path.dirname(symlinkTokenPath), value)),
      Effect.orElseSucceed(() => undefined),
    );
    if (existingTarget !== expectedTarget) {
      yield* fs.remove(symlinkTokenPath, { recursive: true, force: true });
      const linked = yield* fs.symlink(expectedTarget, symlinkTokenPath).pipe(Effect.result);
      if (Result.isFailure(linked)) {
        yield* Effect.logWarning(
          "Skipping Antigravity usage probe because the token symlink could not be created.",
          { instanceId: instance.instanceId, platform },
        );
        return "symlink-unsupported" as const;
      }
    }
    return "ready" as const;
  });

  const executeSingleProbe = Effect.fn("AntigravityUsageLimits.executeSingleProbe")(function* () {
    if (!supportsQuota || !instance.enabled) {
      yield* clearUsageState();
      return;
    }
    const snapshot = yield* baseSnapshot.getSnapshot;
    const awaiting = yield* baseSnapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
    if (
      !snapshot.enabled ||
      snapshot.auth.status === "unauthenticated" ||
      (!awaiting && !snapshot.installed)
    ) {
      yield* clearUsageState();
      return;
    }

    const tokenState = yield* ensureUsageTokenSymlink().pipe(
      Effect.orElseSucceed(() => "missing-token" as const),
    );
    if (tokenState !== "ready") {
      yield* clearUsageState();
      return;
    }

    let cliVersion = "unknown";
    const runProbeProcess = Effect.gen(function* () {
      const executable = yield* installation.acquire(
        options.binaryPath,
        options.processEnvironment,
      );
      cliVersion = executable.version ?? "unknown";
      yield* fs.makeDirectory(options.runtimeTempDirectory, { recursive: true, mode: 0o700 });
      const runTempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: options.runtimeTempDirectory, prefix: "usage-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      yield* fs.writeFileString(usageLogPath, "");
      // Top-level `antigravity -p /usage` ignores `--gemini-dir` and reads `$HOME/.gemini/antigravity-cli/`.
      const acpSpawn = buildAntigravityAcpSpawnInput({
        installation: executable,
        profile: {
          platform,
          geminiHome: options.profileDirectory,
          acpDirectory: path.join(options.profileDirectory, "antigravity-acp"),
          tokenPath: sourceTokenPath,
          tempDirectory: options.runtimeTempDirectory,
          browserCommand: "",
        } satisfies AntigravityProfile,
        cwd: runTempDir,
        baseEnv: options.processEnvironment,
        auth: options.auth,
        runtimeTempDirectory: runTempDir,
      });
      const child = yield* Effect.acquireRelease(
        spawner.spawn(
          ChildProcess.make(
            acpSpawn.command,
            [
              "-p",
              "/usage",
              "--output-format",
              "json",
              "--print-timeout",
              "25s",
              "--log-file",
              usageLogPath,
            ],
            {
              cwd: runTempDir,
              env: {
                ...acpSpawn.env,
                HOME: usageHome,
                ...(platform === "win32" ? { USERPROFILE: usageHome } : {}),
              },
              extendEnv: false,
              shell: false,
              stdin: "ignore",
            },
          ),
        ),
        (handle) =>
          handle.isRunning.pipe(
            Effect.flatMap((running) =>
              running ? handle.kill({ forceKillAfter: "1 second" }) : Effect.void,
            ),
            Effect.ignore,
          ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_STDOUT_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_STDERR_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: stdout.text,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.text,
      };
    });

    const processScope = yield* Scope.make();
    const exit = yield* Effect.gen(function* () {
      yield* Effect.addFinalizer((closeExit) => Scope.close(processScope, closeExit));
      return yield* runWithAuthGuard(
        Scope.close(processScope, Exit.void),
        runProbeProcess.pipe(Effect.scoped, Effect.timeoutOption(CLI_HARD_TIMEOUT_MS)),
      ).pipe(Effect.provideService(Scope.Scope, processScope));
    }).pipe(Effect.scoped, Effect.exit);

    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause) || isStartProcessBusyError(exit.cause)) {
        return;
      }
      const errorOption = Cause.findErrorOption(exit.cause);
      if (
        Option.isSome(errorOption) &&
        Predicate.isObject(errorOption.value) &&
        errorOption.value._tag === "AntigravityInstallationError" &&
        errorOption.value.operation === "resolve"
      ) {
        return;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const detail = Option.isSome(errorOption)
        ? errorOption.value instanceof Error
          ? firstSanitizedLine(errorOption.value.message)
          : firstSanitizedLine(String(errorOption.value))
        : "Antigravity /usage failed.";
      yield* Effect.logWarning("Antigravity usage probe failed.", {
        instanceId: instance.instanceId,
        cliVersion,
        error: detail,
      });
      const { changed } = yield* Ref.modify(usageStateRef, (state) => {
        const result = applyFailureToUsageState({ state, nowMs, nowIso });
        return [result, result.next] as const;
      });
      yield* Queue.offer(scheduleResetQueue, undefined);
      if (changed) yield* publishUsageChanged;
      return;
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const timedOutcome = exit.value;
    if (Option.isNone(timedOutcome)) {
      yield* Effect.logWarning("Antigravity usage probe timed out.", {
        instanceId: instance.instanceId,
        cliVersion,
        error: "Timed out after 30s.",
      });
      const { changed } = yield* Ref.modify(usageStateRef, (state) => {
        const result = applyFailureToUsageState({ state, nowMs, nowIso });
        return [result, result.next] as const;
      });
      yield* Queue.offer(scheduleResetQueue, undefined);
      if (changed) yield* publishUsageChanged;
      return;
    }

    const output = timedOutcome.value;
    if (output.exitCode !== 0 || output.stdoutTruncated) {
      const errorLine = output.stdoutTruncated
        ? "Antigravity /usage output exceeded maximum buffer size."
        : firstSanitizedLine(
            output.stderr || output.stdout || `Exited with code ${output.exitCode}.`,
          );
      yield* Effect.logWarning("Antigravity usage probe exited with error.", {
        instanceId: instance.instanceId,
        cliVersion,
        exitCode: output.exitCode,
        error: errorLine,
      });
      const { changed } = yield* Ref.modify(usageStateRef, (state) => {
        const result = applyFailureToUsageState({ state, nowMs, nowIso });
        return [result, result.next] as const;
      });
      yield* Queue.offer(scheduleResetQueue, undefined);
      if (changed) yield* publishUsageChanged;
      return;
    }

    const parsed = parseAntigravityUsageOutput({
      stdout: output.stdout,
      checkedAt: nowIso,
      nowMs,
    });
    if (!parsed.ok) {
      yield* Effect.logWarning("Antigravity usage probe returned unusable output.", {
        instanceId: instance.instanceId,
        cliVersion,
        error: firstSanitizedLine(parsed.reason),
      });
      const { changed } = yield* Ref.modify(usageStateRef, (state) => {
        const result = applyFailureToUsageState({ state, nowMs, nowIso });
        return [result, result.next] as const;
      });
      yield* Queue.offer(scheduleResetQueue, undefined);
      if (changed) yield* publishUsageChanged;
      return;
    }

    const prevLimits = yield* Ref.modify(usageStateRef, (state) => [
      state.limits,
      {
        limits: parsed.limits,
        lastSuccessAtMs: nowMs,
        consecutiveFailures: 0,
      } satisfies UsageState,
    ]);
    yield* Queue.offer(scheduleResetQueue, undefined);
    if (!Equal.equals(prevLimits, parsed.limits)) {
      yield* publishUsageChanged;
    }
  });

  const triggerUsageProbe = Effect.fn("AntigravityUsageLimits.triggerProbe")(function* (input: {
    readonly minCacheAgeMs: number;
  }): Effect.fn.Return<void> {
    const existing = yield* Ref.get(inFlightRef);
    if (existing !== null) {
      yield* Deferred.await(existing);
      if (input.minCacheAgeMs > 0) return;
      return yield* triggerUsageProbe(input);
    }
    if (input.minCacheAgeMs > 0) {
      const { lastSuccessAtMs } = yield* Ref.get(usageStateRef);
      if (lastSuccessAtMs !== undefined) {
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs - lastSuccessAtMs < input.minCacheAgeMs) {
          return;
        }
      }
    }
    const deferred = yield* Deferred.make<void>();
    const claimed = yield* Ref.modify(inFlightRef, (current) =>
      current === null ? ([true, deferred] as const) : ([false, current] as const),
    );
    if (!claimed) {
      const active = yield* Ref.get(inFlightRef);
      if (active !== null) yield* Deferred.await(active);
      if (input.minCacheAgeMs > 0) return;
      return yield* triggerUsageProbe(input);
    }
    const runFiber = yield* executeSingleProbe().pipe(Effect.forkIn(instanceScope));
    yield* Ref.set(activeRunFiberRef, runFiber);
    yield* Fiber.await(runFiber).pipe(
      Effect.ensuring(
        Ref.set(activeRunFiberRef, null).pipe(
          Effect.andThen(Ref.set(inFlightRef, null)),
          Effect.andThen(Deferred.succeed(deferred, undefined)),
        ),
      ),
    );
  });

  const shouldRunBackgroundWork = Effect.all([
    host.shouldRunBackgroundWork({ type: "provider-status" }),
    host.shouldRunBackgroundWork({ type: "provider-status", instanceId: instance.instanceId }),
  ]).pipe(Effect.map(([genericDemand, instanceDemand]) => genericDemand || instanceDemand));

  if (supportsQuota && instance.enabled) {
    let previousAuthStatus: ServerProvider["auth"]["status"] = (yield* baseSnapshot.getSnapshot)
      .auth.status;

    const markFirstCheckIfDone = Effect.gen(function* () {
      const awaiting = yield* baseSnapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
      if (!awaiting) {
        yield* Deferred.succeed(firstCheckDone, undefined);
      }
    });
    yield* markFirstCheckIfDone;

    yield* baseSnapshot.streamChanges.pipe(
      Stream.runForEach((snapshot) =>
        Effect.gen(function* () {
          yield* markFirstCheckIfDone;
          const nextStatus = snapshot.auth.status;
          const prevStatus = previousAuthStatus;
          previousAuthStatus = nextStatus;
          if (nextStatus === "unauthenticated" && prevStatus !== "unauthenticated") {
            yield* interruptActiveRun();
            yield* Ref.set(usageStateRef, INITIAL_USAGE_STATE);
          }
          yield* PubSub.publish(mergedChangesPubSub, yield* overlaySnapshot(snapshot));
          if (nextStatus === "authenticated" && prevStatus === "unauthenticated") {
            yield* clearUsageState();
            yield* triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(instanceScope),
            );
            return;
          }
          if (nextStatus === "authenticated" && prevStatus === "unknown") {
            const { lastSuccessAtMs } = yield* Ref.get(usageStateRef);
            if (lastSuccessAtMs === undefined) {
              yield* triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.forkIn(instanceScope),
              );
            }
          }
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(instanceScope),
    );
    yield* Effect.yieldNow;

    if (instance.auth) {
      let previousPhase: ProviderAuthState["phase"] | undefined;
      yield* instance.auth.subscribe("__antigravity_usage_limits__").pipe(
        Stream.runForEach((authState) =>
          Effect.gen(function* () {
            const prev = previousPhase;
            previousPhase = authState.phase;
            if (prev !== undefined && prev !== "succeeded" && authState.phase === "succeeded") {
              yield* interruptActiveRun();
              yield* clearUsageState();
              yield* triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.forkIn(instanceScope),
              );
            }
          }),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(instanceScope),
      );
    }

    yield* Effect.gen(function* () {
      yield* host.awaitServerReady ?? Effect.void;
      const awaiting = yield* baseSnapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
      if (awaiting) {
        yield* Deferred.await(firstCheckDone);
      }
      const { lastSuccessAtMs } = yield* Ref.get(usageStateRef);
      if (lastSuccessAtMs === undefined) {
        yield* triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(Effect.ignoreCause({ log: true }));
      }
      return yield* Effect.forever(
        Effect.gen(function* () {
          yield* Queue.clear(scheduleResetQueue);
          const delayMs = yield* Ref.get(usageStateRef).pipe(
            Effect.map((state) => nextUsageProbeDelayMs(state.consecutiveFailures)),
          );
          // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- races the interval against schedule resets, not a timeout
          const elapsed = yield* Effect.raceFirst(
            Effect.sleep(delayMs).pipe(Effect.as(true)),
            Queue.take(scheduleResetQueue).pipe(Effect.as(false)),
          );
          if (!elapsed) return;
          if (!(yield* shouldRunBackgroundWork)) return;
          yield* triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(Effect.ignoreCause({ log: true }));
        }),
      );
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(instanceScope));
  }

  return {
    ...instance,
    snapshot: {
      ...baseSnapshot,
      getSnapshot: getWrappedSnapshot,
      refresh: baseSnapshot.refresh.pipe(
        Effect.tap(() =>
          triggerUsageProbe({ minCacheAgeMs: MANUAL_REFRESH_CACHE_MS }).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(instanceScope),
          ),
        ),
        Effect.flatMap(overlaySnapshot),
      ),
      refreshUsage: triggerUsageProbe({ minCacheAgeMs: 0 }).pipe(Effect.ignoreCause({ log: true })),
      get streamChanges() {
        return supportsQuota && instance.enabled
          ? Stream.fromPubSub(mergedChangesPubSub)
          : baseSnapshot.streamChanges;
      },
    },
    ...(instance.snapshotForCwd
      ? {
          snapshotForCwd: (cwd: string) =>
            instance.snapshotForCwd!(cwd).pipe(Effect.flatMap(overlaySnapshot)),
        }
      : {}),
  };
});
