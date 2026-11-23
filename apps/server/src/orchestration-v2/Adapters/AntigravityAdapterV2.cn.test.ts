import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const NOT_FOUND_ERROR = Buffer.concat([
  Buffer.from([0x0a, 0x24]),
  Buffer.from(
    "Agent execution terminated due to error.\u0012agent executor error: Error 404, Message: Requested entity was not found., Status: NOT_FOUND, Details: []",
  ),
]);

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const openSteerHarness = Effect.fn("openSteerHarness")(function* (options: {
  readonly onPrompt: (input: {
    readonly index: number;
    readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>;
    readonly send: (
      update: EffectAcpSchema.SessionUpdate,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly appendSteps: (steps: ReadonlyArray<readonly [number, Uint8Array]>) => void;
    readonly steered: Deferred.Deferred<void>;
    readonly releaseSteer: Deferred.Deferred<void>;
  }) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* SecureRandom.SecureRandom;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  yield* fs.makeDirectory(conversations, { recursive: true });
  const dbPath = path.join(conversations, "mock-session-1.db");
  let nextStepIdx = 0;
  const appendSteps = (steps: ReadonlyArray<readonly [number, Uint8Array]>) => {
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
      );
      const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
      for (const [type, payload] of steps) insert.run(nextStepIdx++, type, payload);
    } finally {
      db.close();
    }
  };

  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
  let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
  const send = (update: EffectAcpSchema.SessionUpdate) =>
    sessionUpdate === undefined
      ? Effect.die("adapter must handle session updates")
      : sessionUpdate(normalizeAntigravitySessionUpdate({ sessionId: "mock-session-1", update }));

  const prompts: Array<ReadonlyArray<EffectAcpSchema.ContentBlock>> = [];
  const steered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  const instanceId = ProviderInstanceId.make("antigravity-steer-cn-test");
  const threadId = ThreadId.make("thread-antigravity-steer-cn");
  const selfInvocation = yield* resolveSelfInvocation();

  const adapter = yield* makeAntigravityAdapterV2({
    instanceId,
    selfInvocation,
    profileDirectory,
    withProcess: (_stop, task) => task,
    defaultModel: Effect.undefined,
    makeRuntime: (input) =>
      makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd: input.cwd,
          env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_AGENT_VERSION: "1.5.13" },
        },
      }).pipe(
        Effect.provideService(SecureRandom.SecureRandom, crypto),
        Effect.map((runtime): RuntimeService => ({
          ...runtime,
          handleSessionUpdate: (handler) =>
            Effect.sync(() => {
              sessionUpdate = handler;
            }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
          prompt: (payload, promptOptions) =>
            Effect.gen(function* () {
              const index = prompts.length;
              prompts.push(payload.prompt);
              if (promptOptions?.dispatched !== undefined) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              return yield* options.onPrompt({
                index,
                prompt: payload.prompt,
                send,
                appendSteps,
                steered,
                releaseSteer,
              });
            }),
        })),
      ),
  });

  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "gemini-test-low" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-steer-cn"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const until = (done: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (done(event)) return seen;
      }
    });
  const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const runId = RunId.make("run-steer-cn-1");
  const startTurn = () =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-steer-cn"),
        title: "Antigravity steer cn",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId,
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-steer-cn-1"),
      rootNodeId: NodeId.make("node-steer-cn-1"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("msg-initial-cn"),
        text: "Start work",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  return {
    session,
    providerThread,
    threadId,
    runId,
    prompts,
    appendSteps,
    steered,
    releaseSteer: Deferred.succeed(releaseSteer, undefined),
    startTurn,
    until,
  };
});

describe("AntigravityAdapterV2 steer delivery and wrapping", () => {
  it.effect("wraps user steer text and completes steer.updated once PLANNER_RESPONSE lands", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const harness = yield* openSteerHarness({
        onPrompt: ({ index, send, appendSteps, steered, releaseSteer }) =>
          Effect.gen(function* () {
            if (index === 0) {
              appendSteps([[USER_INPUT, Buffer.from("Start work")]]);
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "call_work",
                kind: "execute",
                title: "ls",
                status: "in_progress",
              });
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }
            yield* Deferred.succeed(steered, undefined);
            yield* Deferred.await(releaseSteer);
            yield* send({
              sessionUpdate: "tool_call_update",
              toolCallId: "call_work",
              kind: "execute",
              title: "ls",
              status: "completed",
            });
            appendSteps([
              [USER_INPUT, Buffer.from("steer")],
              [PLANNER_RESPONSE, Buffer.from("ack steer")],
            ]);
            yield* send({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Acknowledged, switching focus." },
            });
            yield* send({ sessionUpdate: "usage_update", used: 1000, size: 100000 });
            return { stopReason: "end_turn" as const };
          }),
      });

      yield* harness.startTurn();
      yield* Deferred.await(firstStarted);
      const started = yield* harness.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "call_work",
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      const steerMessageId = MessageId.make("msg-steer-delivered");
      yield* harness.session.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId,
        message: {
          messageId: steerMessageId,
          text: "Focus on tests instead",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });

      const steerPromptBlock = harness.prompts[1]?.[0];
      assert.equal(steerPromptBlock?.type, "text");
      const steerPromptText = steerPromptBlock?.type === "text" ? steerPromptBlock.text : "";
      assert.isTrue(steerPromptText.startsWith("<user_steer>\n"));
      assert.include(steerPromptText, "Focus on tests instead");
      assert.isTrue(steerPromptText.endsWith("\n</user_steer>"));

      yield* harness.releaseSteer;
      const tailEvents = yield* harness.until((event) => event.type === "turn.terminal");
      const steerStatuses = [...started, ...tailEvents].flatMap((event) =>
        event.type === "steer.updated" && event.messageId === steerMessageId ? [event.status] : [],
      );
      assert.deepEqual(steerStatuses, ["pending", "completed"]);
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "keeps steer.updated pending when the turn ends without PLANNER_RESPONSE after USER_INPUT",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const harness = yield* openSteerHarness({
          onPrompt: ({ index, send, appendSteps, steered, releaseSteer }) =>
            Effect.gen(function* () {
              if (index === 0) {
                appendSteps([[USER_INPUT, Buffer.from("Start work")]]);
                yield* send({
                  sessionUpdate: "tool_call",
                  toolCallId: "call_work",
                  kind: "execute",
                  title: "ls",
                  status: "in_progress",
                });
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(steered);
                return { stopReason: "end_turn" as const };
              }
              yield* Deferred.succeed(steered, undefined);
              yield* Deferred.await(releaseSteer);
              yield* send({
                sessionUpdate: "tool_call_update",
                toolCallId: "call_work",
                kind: "execute",
                title: "ls",
                status: "completed",
              });
              // Steer landed in DB as USER_INPUT, but model never wrote PLANNER_RESPONSE.
              appendSteps([[USER_INPUT, Buffer.from("unread steer")]]);
              return { stopReason: "end_turn" as const };
            }),
        });

        yield* harness.startTurn();
        yield* Deferred.await(firstStarted);
        const started = yield* harness.until(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "call_work",
        );
        const providerTurnId = started.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
        )[0]!;

        const steerMessageId = MessageId.make("msg-steer-unread");
        yield* harness.session.steerTurn({
          threadId: harness.threadId,
          runId: harness.runId,
          providerThread: harness.providerThread,
          providerTurnId,
          message: {
            messageId: steerMessageId,
            text: "Do not ignore this",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        });

        yield* harness.releaseSteer;
        const tailEvents = yield* harness.until((event) => event.type === "turn.terminal");
        const steerStatuses = [...started, ...tailEvents].flatMap((event) =>
          event.type === "steer.updated" && event.messageId === steerMessageId
            ? [event.status]
            : [],
        );
        assert.deepEqual(steerStatuses, ["pending"]);
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect("does not wrap or track internal resumeWith continue prompts", () =>
    Effect.gen(function* () {
      const harness = yield* openSteerHarness({
        onPrompt: ({ index, send, appendSteps }) =>
          Effect.gen(function* () {
            if (index === 0) {
              appendSteps([
                [USER_INPUT, Buffer.from("Start work")],
                [PLANNER_RESPONSE, Buffer.from("working")],
                [ERROR_MESSAGE, NOT_FOUND_ERROR],
              ]);
              return { stopReason: "end_turn" as const };
            }
            appendSteps([
              [USER_INPUT, Buffer.from("continue")],
              [PLANNER_RESPONSE, Buffer.from("resumed")],
            ]);
            yield* send({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Resumed ok." },
            });
            yield* send({ sessionUpdate: "usage_update", used: 1000, size: 100000 });
            return { stopReason: "end_turn" as const };
          }),
      });

      yield* harness.startTurn();
      const events = yield* harness.until((event) => event.type === "turn.terminal");
      assert.lengthOf(harness.prompts, 2);
      const resumeBlock = harness.prompts[1]?.[0];
      assert.equal(resumeBlock?.type, "text");
      assert.equal(resumeBlock?.type === "text" ? resumeBlock.text : "", "continue");
      assert.isEmpty(events.filter((event) => event.type === "steer.updated"));
    }).pipe(Effect.provide(layerSession)),
  );

  it.effect("does not wrap non-user steers (e.g. system/delegated notices) in <user_steer>", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const harness = yield* openSteerHarness({
        onPrompt: ({ index, send, appendSteps, steered, releaseSteer }) =>
          Effect.gen(function* () {
            if (index === 0) {
              appendSteps([[USER_INPUT, Buffer.from("Start work")]]);
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "call_work",
                kind: "execute",
                title: "ls",
                status: "in_progress",
              });
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(steered);
              return { stopReason: "end_turn" as const };
            }
            yield* Deferred.succeed(steered, undefined);
            yield* Deferred.await(releaseSteer);
            yield* send({
              sessionUpdate: "tool_call_update",
              toolCallId: "call_work",
              kind: "execute",
              title: "ls",
              status: "completed",
            });
            appendSteps([
              [USER_INPUT, Buffer.from("delegated done")],
              [PLANNER_RESPONSE, Buffer.from("ack")],
            ]);
            yield* send({ sessionUpdate: "usage_update", used: 1000, size: 100000 });
            return { stopReason: "end_turn" as const };
          }),
      });

      yield* harness.startTurn();
      yield* Deferred.await(firstStarted);
      const started = yield* harness.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "call_work",
      );
      const providerTurnId = started.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn.id] : [],
      )[0]!;

      yield* harness.session.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId,
        message: {
          messageId: MessageId.make("msg-steer-system"),
          text: "[T3 Code: delegated task completed]",
          attachments: [],
          createdBy: "system",
          creationSource: "server",
        },
      });

      const steerBlock = harness.prompts[1]?.[0];
      assert.equal(steerBlock?.type, "text");
      assert.equal(
        steerBlock?.type === "text" ? steerBlock.text : "",
        "[T3 Code: delegated task completed]",
      );

      yield* harness.releaseSteer;
      yield* harness.until((event) => event.type === "turn.terminal");
    }).pipe(Effect.provide(layerSession)),
  );
});
