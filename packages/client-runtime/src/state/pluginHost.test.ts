import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, PluginId, WS_METHODS, type PluginHostSnapshot } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createPluginHostEnvironmentAtoms } from "./pluginHost.ts";

const snapshot = (name: string): PluginHostSnapshot => ({
  hostEnabled: true,
  registered: 1,
  plugins: [],
  views: [
    {
      pluginId: PluginId.make(name),
      pluginName: name,
      generation: 1,
      viewId: "main",
      title: name,
      placement: "side-panel",
    },
  ],
  services: [],
});

const makeEnvironment = Effect.fn("TestPluginHost.makeEnvironment")(function* (id: string) {
  const environmentId = EnvironmentId.make(id);
  const frames = yield* Queue.unbounded<PluginHostSnapshot>();
  const subscriptions = yield* Queue.unbounded<void>();
  const session = (): RpcSession.RpcSession =>
    ({
      client: {
        [WS_METHODS.pluginHostSubscribe]: () =>
          Stream.fromEffect(Queue.offer(subscriptions, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(frames)),
          ),
      },
    }) as unknown as RpcSession.RpcSession;
  const sessionRef = yield* SubscriptionRef.make(Option.some(session()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: id,
      httpBaseUrl: "https://plugin-host.example.test",
      wsBaseUrl: "wss://plugin-host.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    environmentId,
    supervisor,
    frames,
    subscriptions,
    reconnect: SubscriptionRef.set(sessionRef, Option.some(session())),
  };
});

describe("plugin host snapshots", () => {
  it.effect("keeps each environment's snapshot apart and restores it after a reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* makeEnvironment("first");
        const second = yield* makeEnvironment("second");
        const supervisors = new Map(
          [first, second].map((item) => [item.environmentId, item.supervisor]),
        );
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          followStream: (
            environmentId: EnvironmentId,
            stream: Stream.Stream<unknown, unknown, unknown>,
          ) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisors.get(environmentId)!,
            ),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const { snapshot: family } = createPluginHostEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
        );
        const registry = AtomRegistry.make();
        const latest = new Map<string, Deferred.Deferred<PluginHostSnapshot>>();
        const watch = (environmentId: EnvironmentId) => {
          const atom = family({ environmentId, input: {} });
          const unsubscribe = registry.subscribe(
            atom,
            (result) => {
              const seen = latest.get(environmentId);
              if (AsyncResult.isSuccess(result) && seen !== undefined) {
                Deferred.doneUnsafe(seen, Exit.succeed(result.value));
              }
            },
            { immediate: true },
          );
          return Effect.addFinalizer(() => Effect.sync(unsubscribe));
        };
        yield* watch(first.environmentId);
        yield* watch(second.environmentId);
        yield* Queue.take(first.subscriptions);
        yield* Queue.take(second.subscriptions);

        const nextFrame = Effect.fn("nextFrame")(function* (
          item: typeof first,
          frame: PluginHostSnapshot,
        ) {
          const seen = yield* Deferred.make<PluginHostSnapshot>();
          latest.set(item.environmentId, seen);
          yield* Queue.offer(item.frames, frame);
          return yield* Deferred.await(seen);
        });
        const read = (item: typeof first) => {
          const result = registry.get(family({ environmentId: item.environmentId, input: {} }));
          return AsyncResult.isSuccess(result) ? result.value : null;
        };

        expect(yield* nextFrame(first, snapshot("alpha"))).toEqual(snapshot("alpha"));
        expect(yield* nextFrame(second, snapshot("beta"))).toEqual(snapshot("beta"));
        expect(read(first)).toEqual(snapshot("alpha"));
        // A frame replaces the previous one whole.
        expect(
          yield* nextFrame(first, { ...snapshot("alpha"), hostEnabled: false, views: [] }),
        ).toEqual({
          ...snapshot("alpha"),
          hostEnabled: false,
          views: [],
        });
        expect(read(second)).toEqual(snapshot("beta"));

        yield* first.reconnect;
        yield* Queue.take(first.subscriptions);
        expect(yield* nextFrame(first, snapshot("alpha-again"))).toEqual(snapshot("alpha-again"));
        expect(read(second)).toEqual(snapshot("beta"));
        registry.dispose();
      }),
    ),
  );
});
