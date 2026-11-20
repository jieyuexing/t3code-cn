import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { Service, cordisPlugin } from "../index.mjs";

/** A stand-in for the host's plugin context: records what the plugin registers and what it calls. */
const fakeHost = ({ services = {}, provides = [] } = {}) => {
  const logged = [];
  const registered = {};
  const storage = new Map();
  return {
    logged,
    registered,
    storage,
    context: {
      pluginId: "test.plugin",
      provides,
      log: { info: (...parts) => logged.push(parts.join(" ")) },
      handle: () => {},
      services,
      provide: (name, methods) => {
        registered[name] = methods;
      },
      storage: {
        get: async (key) => storage.get(key) ?? null,
        set: async (key, value) => storage.set(key, value),
      },
    },
  };
};

/** Like the child runtime's proxy: any method name is a call that goes to the host. */
const forwardingService = (calls) =>
  new Proxy(
    {},
    {
      get: (_target, method) =>
        typeof method === "string" && method !== "then"
          ? async (input) => {
              calls.push({ method, input });
              return { via: "host", method };
            }
          : undefined,
    },
  );

class Greeter extends Service {
  static inject = ["example.clock", "t3"];
  constructor(ctx) {
    super(ctx, "example.greeter");
    const { log } = ctx.t3;
    ctx.effect(() => () => log.info("greeter stopped"));
  }
  async greet({ name }, meta) {
    return {
      greeting: `Hello, ${name}!`,
      caller: meta?.caller,
      clock: await this.ctx["example.clock"].now({ label: "x" }),
    };
  }
}

const GREETER = [{ name: "example.greeter", methods: ["greet"] }];

NodeTest.test(
  "a service call goes through the injected host service, with the caller passed along",
  async () => {
    const calls = [];
    const { context, registered } = fakeHost({
      services: { "example.clock": forwardingService(calls) },
      provides: GREETER,
    });
    const entry = cordisPlugin(Greeter);
    await entry.activate(context);
    const result = await registered["example.greeter"].greet(
      { name: "Ada" },
      { caller: "t3:user" },
    );
    NodeAssert.deepEqual(result, {
      greeting: "Hello, Ada!",
      caller: "t3:user",
      clock: { via: "host", method: "now" },
    });
    NodeAssert.deepEqual(calls, [{ method: "now", input: { label: "x" } }]);
    await entry.deactivate();
  },
);

NodeTest.test("the host's own context is the service t3", async () => {
  const { context, logged, registered, storage } = fakeHost({
    provides: [{ name: "probe.t3", methods: ["run"] }],
  });
  class Probe extends Service {
    static inject = ["t3"];
    constructor(ctx) {
      super(ctx, "probe.t3");
    }
    async run() {
      this.ctx.t3.log.info("from the plugin");
      await this.ctx.t3.storage.set("seen", this.ctx.t3.pluginId);
      return this.ctx.t3 === context;
    }
  }
  const entry = cordisPlugin(Probe);
  await entry.activate(context);
  NodeAssert.equal(await registered["probe.t3"].run({}, { caller: "t3:user" }), true);
  NodeAssert.deepEqual(logged, ["from the plugin"]);
  NodeAssert.equal(storage.get("seen"), "test.plugin");
  await entry.deactivate();
});

NodeTest.test("a plugin object works as well as a Service class", async () => {
  const { context, registered } = fakeHost({
    provides: [{ name: "plain.service", methods: ["ping"] }],
  });
  const entry = cordisPlugin(
    {
      apply(ctx, config) {
        ctx.provide("plain.service", { ping: () => `pong ${config.word}` });
      },
    },
    { word: "ok" },
  );
  await entry.activate(context);
  NodeAssert.equal(registered["plain.service"].ping({}, { caller: "x" }), "pong ok");
  await entry.deactivate();
});

NodeTest.test("deactivating runs the cleanup registered with ctx.effect", async () => {
  const { context, logged } = fakeHost({
    services: { "example.clock": forwardingService([]) },
    provides: GREETER,
  });
  const entry = cordisPlugin(Greeter);
  await entry.activate(context);
  NodeAssert.deepEqual(logged, []);
  await entry.deactivate();
  NodeAssert.deepEqual(logged, ["greeter stopped"]);
});

NodeTest.test("activation fails, naming the services that are missing", async () => {
  const { context, registered } = fakeHost({
    provides: [{ name: "needy.service", methods: ["run"] }],
  });
  class Needy extends Service {
    static inject = ["example.clock", "example.absent", "t3"];
    constructor(ctx) {
      super(ctx, "needy.service");
    }
  }
  await NodeAssert.rejects(
    cordisPlugin(Needy).activate(context),
    /waiting for services nobody provides: example\.clock, example\.absent\./,
  );
  NodeAssert.deepEqual(registered, {});
});

NodeTest.test("activation fails when the manifest's service is not provided", async () => {
  const { context } = fakeHost({ provides: GREETER });
  await NodeAssert.rejects(
    cordisPlugin({ apply() {} }).activate(context),
    /did not provide the service example\.greeter/,
  );
});

NodeTest.test("activation fails when a declared method is not a function", async () => {
  const { context, registered } = fakeHost({
    provides: [{ name: "half.service", methods: ["run", "missing", "notFunction"] }],
  });
  class Half extends Service {
    notFunction = 1;
    constructor(ctx) {
      super(ctx, "half.service");
    }
    run() {}
  }
  await NodeAssert.rejects(
    cordisPlugin(Half).activate(context),
    /The service half\.service has no function for: missing, notFunction\./,
  );
  NodeAssert.deepEqual(registered, {});
});

NodeTest.test(
  "activation fails with the error apply throws, and its cleanup still runs",
  async () => {
    const { context, logged } = fakeHost();
    const entry = cordisPlugin({
      inject: ["t3"],
      apply(ctx) {
        ctx.effect(() => () => ctx.t3.log.info("cleaned"));
        throw new Error("boom");
      },
    });
    await NodeAssert.rejects(entry.activate(context), /boom/);
    NodeAssert.deepEqual(logged, ["cleaned"]);
    await entry.deactivate();
  },
);
