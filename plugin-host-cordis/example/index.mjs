import { Service, cordisPlugin } from "@t3-plugin-host/cordis";

class Counter extends Service {
  static inject = ["t3", "example.clock"];

  constructor(ctx) {
    super(ctx, "example.counter");
    const { log, storage } = ctx.t3;
    ctx.effect(() => async () => {
      log.info("counter stopped");
      await storage.set("stops", ((await storage.get("stops")) ?? 0) + 1);
    });
  }

  async increment({ by = 1 } = {}) {
    const { storage } = this.ctx.t3;
    const value = ((await storage.get("count")) ?? 0) + by;
    await storage.set("count", value);
    const { text } = await this.ctx["example.clock"].now({});
    return { value, time: text };
  }

  async get() {
    return { value: (await this.ctx.t3.storage.get("count")) ?? 0 };
  }
}

export const { activate, deactivate } = cordisPlugin(Counter);
