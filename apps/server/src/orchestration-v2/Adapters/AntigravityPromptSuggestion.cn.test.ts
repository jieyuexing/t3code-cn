import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  type AntigravityAdapterV2Options,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 prompt suggestions (cn)", () => {
  const makePromptSuggestionSession = Effect.fn("makeAntigravityPromptSuggestionSessionCn")(
    function* (options: {
      readonly promptSuggestions: Effect.Effect<boolean>;
      readonly samplePromptSuggestion: NonNullable<
        AntigravityAdapterV2Options["samplePromptSuggestion"]
      >;
      readonly assistantText?: string;
      readonly continuationRequests?: AntigravityAdapterV2Options["continuationRequests"];
    }) {
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const instanceId = ProviderInstanceId.make("antigravity-prompt-suggestion-cn-test");
      const threadId = ThreadId.make("thread-antigravity-prompt-suggestion-cn");
      const modelSelection = { instanceId, model: "gemini-4-neon" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntime.AcpSessionRuntimeEvent>();
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const initializeResult: EffectAcpSchema.InitializeResponse = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, list: {}, close: {} },
        },
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
      };
      const startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult = {
        sessionId: "mock-suggestion-session",
        initializeResult,
        modelConfigId: "model",
        sessionSetupResult: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: modelSelection.model,
              options: [{ value: modelSelection.model, name: "Gemini Neon" }],
            },
          ],
        },
      };
      const mockRuntime: RuntimeService = {
        initialize: () => Effect.succeed(initializeResult),
        start: () =>
          Effect.gen(function* () {
            if (sessionUpdate !== undefined) {
              yield* sessionUpdate({
                sessionId: startResult.sessionId,
                update: {
                  sessionUpdate: "available_commands_update",
                  availableCommands: [{ name: "compact", description: "Compact" }],
                },
              });
            }
            return startResult;
          }),
        loadSession: () => Effect.succeed(startResult),
        resumeSession: () => Effect.succeed(startResult),
        forkSession: () => Effect.succeed(startResult),
        listSessions: () => Effect.succeed({ sessions: [] }),
        closeSession: () => Effect.succeed({}),
        deleteSession: () => Effect.succeed({}),
        listProviders: Effect.succeed({ providers: [] }),
        setProvider: () => Effect.succeed({}),
        disableProvider: () => Effect.succeed({}),
        logout: Effect.succeed({}),
        getEvents: () => Stream.fromQueue(runtimeEvents),
        drainEvents: Effect.void,
        getConfigOptions: Effect.succeed(startResult.sessionSetupResult.configOptions ?? []),
        configOptionChanges: Stream.empty,
        getModeState: Effect.undefined,
        setMode: () => Effect.succeed({}),
        setSessionModel: () => Effect.succeed({}),
        setModel: () => Effect.void,
        setConfigOption: () => Effect.succeed({ configOptions: [] }),
        prompt: (_payload, promptOptions) =>
          Effect.gen(function* () {
            if (promptOptions?.dispatched !== undefined) {
              yield* Deferred.succeed(promptOptions.dispatched, undefined);
            }
            if (sessionUpdate !== undefined) {
              yield* sessionUpdate({
                sessionId: startResult.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: options.assistantText ?? "Added subtract in math.ts.",
                  },
                },
              });
            }
            return { stopReason: "end_turn" as const };
          }),
        cancel: Effect.void,
        request: () => Effect.die("unused"),
        notify: () => Effect.void,
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: () => Effect.void,
        handleElicitation: () => Effect.void,
        handleElicitationComplete: () => Effect.void,
        handleMcpConnect: () => Effect.void,
        handleMcpMessage: () => Effect.void,
        handleMcpDisconnect: () => Effect.void,
        handleMcpNotification: () => Effect.void,
        handleReadTextFile: () => Effect.void,
        handleWriteTextFile: () => Effect.void,
        handleCreateTerminal: () => Effect.void,
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: () => Effect.void,
        handleUnknownExtNotification: () => Effect.void,
        handleExtRequest: () => Effect.void,
        handleExtNotification: () => Effect.void,
      };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.succeed(mockRuntime),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
        samplePromptSuggestion: options.samplePromptSuggestion,
        ...(options.continuationRequests !== undefined
          ? { continuationRequests: options.continuationRequests }
          : {}),
      });
      const sessionScope = yield* Scope.fork(yield* Effect.scope);
      const session = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-suggestion-cn"),
          modelSelection,
          runtimePolicy,
          promptSuggestions: options.promptSuggestions,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const emittedEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* session.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            emittedEvents.push(event);
          }).pipe(Effect.andThen(Queue.offer(events, event))),
        ),
        Effect.forkIn(sessionScope),
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
        Effect.gen(function* () {
          const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          while (true) {
            const event = yield* Queue.take(events);
            seen.push(event);
            if (done(event)) return seen;
          }
        });
      const now = yield* DateTime.now;
      const makeTurn = (
        ordinal: number,
        overrides?: {
          readonly text?: string;
          readonly delegated?: boolean;
          readonly continuation?: boolean;
        },
      ) => {
        const turn = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          modelSelection,
          runtimePolicy,
          now,
          messageText: overrides?.text ?? `Turn ${ordinal} request`,
        });
        return {
          ...turn,
          runId: RunId.make(`run-suggestion-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make(`attempt-suggestion-${ordinal}`),
          rootNodeId: NodeId.make(`node-suggestion-${ordinal}`),
          appThread: {
            ...turn.appThread,
            lineage: overrides?.delegated
              ? {
                  parentThreadId: ThreadId.make("parent-thread"),
                  relationshipToParent: "subagent" as const,
                  rootThreadId: ThreadId.make("parent-thread"),
                }
              : turn.appThread.lineage,
          },
          message: {
            ...turn.message,
            messageId: MessageId.make(`message-suggestion-${ordinal}`),
            ...(overrides?.continuation
              ? { createdBy: "agent" as const, creationSource: "provider" as const }
              : {}),
          },
        };
      };
      const emitSessionUpdate = (notification: EffectAcpSchema.SessionNotification) =>
        sessionUpdate === undefined ? Effect.void : sessionUpdate(notification);
      return {
        threadId,
        modelSelection,
        providerThread,
        session,
        sessionScope,
        emittedEvents,
        until,
        makeTurn,
        emitSessionUpdate,
      };
    },
  );

  it.effect("reads promptSuggestions live and emits prompt_suggestion.updated when enabled", () =>
    Effect.gen(function* () {
      const enabled = yield* Ref.make(false);
      const sampled: Array<{
        readonly model: string;
        readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
      }> = [];
      const { threadId, modelSelection, session, until, makeTurn } =
        yield* makePromptSuggestionSession({
          promptSuggestions: Ref.get(enabled),
          samplePromptSuggestion: (input) =>
            Effect.sync(() => {
              sampled.push({ model: input.modelSelection.model, messages: input.messages });
              return "  add tests for subtract\n";
            }),
        });

      const turn1 = makeTurn(1, { text: "Add a subtract function." });
      yield* session.startTurn(turn1);
      yield* until((event) => event.type === "turn.terminal");
      assert.equal(sampled.length, 0);

      yield* Ref.set(enabled, true);
      const turn2 = makeTurn(2, { text: "Now add divide." });
      yield* session.startTurn(turn2);
      const events2 = yield* until((event) => event.type === "prompt_suggestion.updated");
      const suggestionEvent = events2.find((event) => event.type === "prompt_suggestion.updated");
      assert.deepEqual(suggestionEvent, {
        type: "prompt_suggestion.updated",
        driver: "antigravity",
        threadId,
        runId: turn2.runId,
        text: "add tests for subtract",
      });
      assert.deepEqual(sampled, [
        {
          model: modelSelection.model,
          messages: [
            { role: "user", text: "Add a subtract function." },
            { role: "assistant", text: "Added subtract in math.ts." },
            { role: "user", text: "Now add divide." },
            { role: "assistant", text: "Added subtract in math.ts." },
          ],
        },
      ]);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("skips delegated threads, continuations, and /compact turns", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { session, until, makeTurn } = yield* makePromptSuggestionSession({
        promptSuggestions: Effect.succeed(true),
        samplePromptSuggestion: () =>
          Effect.sync(() => {
            calls += 1;
            return "should not run";
          }),
      });

      yield* session.startTurn(makeTurn(1, { delegated: true }));
      yield* until((event) => event.type === "turn.terminal");
      yield* session.startTurn(makeTurn(2, { continuation: true }));
      yield* until((event) => event.type === "turn.terminal");
      yield* session.startTurn(makeTurn(3, { text: "/compact" }));
      yield* until((event) => event.type === "turn.terminal");
      assert.equal(calls, 0);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "cancels in-flight suggestions on next turn, interrupt, rollback, session replacement, continuation wake, and session close",
    () =>
      Effect.gen(function* () {
        const started = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ] as const;
        const interrupted = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ] as const;
        const continuationOffered =
          yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
        let callCount = 0;
        const {
          threadId,
          modelSelection,
          providerThread,
          session,
          sessionScope,
          emittedEvents,
          until,
          makeTurn,
          emitSessionUpdate,
        } = yield* makePromptSuggestionSession({
          promptSuggestions: Effect.succeed(true),
          continuationRequests: {
            offer: (request) => Deferred.succeed(continuationOffered, request).pipe(Effect.asVoid),
          },
          samplePromptSuggestion: () =>
            Effect.gen(function* () {
              const index = callCount;
              callCount += 1;
              if (index < 6) {
                yield* Deferred.succeed(started[index]!, undefined);
                return yield* Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted[index]!, undefined).pipe(Effect.asVoid),
                  ),
                );
              }
              return "run the test suite";
            }),
        });

        // 1. Starting the next turn cancels the first in-flight suggestion.
        yield* session.startTurn(makeTurn(1, { text: "First turn" }));
        yield* until((event) => event.type === "turn.terminal");
        yield* Deferred.await(started[0]);

        yield* session.startTurn(makeTurn(2, { text: "Second turn" }));
        yield* Deferred.await(interrupted[0]);
        const turn2Events = yield* until((event) => event.type === "turn.terminal");
        const turn2Started = turn2Events.find((event) => event.type === "provider_turn.updated");
        assert.isDefined(turn2Started);
        yield* Deferred.await(started[1]);

        // 2. Interrupting cancels an in-flight suggestion.
        yield* session.interruptTurn({
          providerThread,
          providerTurnId: turn2Started!.providerTurn.id,
        });
        yield* Deferred.await(interrupted[1]);

        // 3. Rollback cancels an in-flight suggestion before replacing the session.
        yield* session.startTurn(makeTurn(3, { text: "Third turn" }));
        yield* until((event) => event.type === "turn.terminal");
        yield* Deferred.await(started[2]);

        yield* session.rollbackThread({
          providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-before-first-run"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [],
        });
        yield* Deferred.await(interrupted[2]);

        // 4. Forced session replacement cancels an in-flight suggestion.
        yield* session.startTurn(makeTurn(4, { text: "Fourth turn" }));
        yield* until((event) => event.type === "turn.terminal");
        yield* Deferred.await(started[3]);

        yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
          forceNewNativeThread: true,
          existingProviderThread: providerThread,
        });
        yield* Deferred.await(interrupted[3]);

        // 5. Admitting a late continuation cancels an in-flight suggestion and suppresses new ones while pending.
        yield* session.startTurn(makeTurn(5, { text: "Fifth turn" }));
        yield* until((event) => event.type === "turn.terminal");
        yield* Deferred.await(started[4]);

        yield* emitSessionUpdate({
          sessionId: "mock-suggestion-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Late background wake" },
          },
        });
        const offeredRequest = yield* Deferred.await(continuationOffered);
        yield* Deferred.await(interrupted[4]);

        yield* session.startTurn(makeTurn(6, { text: "Sixth turn while continuation pending" }));
        yield* until((event) => event.type === "turn.terminal");
        assert.equal(callCount, 5);

        // 6. Closing the session cancels an in-flight suggestion.
        yield* offeredRequest.clearIfCurrent?.() ?? Effect.void;
        yield* session.startTurn(makeTurn(7, { text: "Seventh turn" }));
        yield* until((event) => event.type === "turn.terminal");
        yield* Deferred.await(started[5]);
        yield* Scope.close(sessionScope, Exit.void);
        yield* Deferred.await(interrupted[5]);

        assert.equal(
          emittedEvents.some((event) => event.type === "prompt_suggestion.updated"),
          false,
        );
      }).pipe(Effect.provide(layerSession)),
  );
});
