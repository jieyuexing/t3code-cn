export async function activate(context) {
  const now = async () =>
    `${(await context.settings.get("prefix")) ?? "Now"}: ${new Date().toISOString()}`;
  context.provide("example.clock", { now: async () => ({ text: await now() }) });
  context.handle("echo", (input) => input);
  context.handle("remember", ({ key, value }) => context.storage.set(key, value));
  context.handle("recall", ({ key }) => context.storage.get(key));
  context.handle("view:clock:now", async () => ({ text: await now() }));
  context.handle("view:clock:echo", (input) => input);
  context.handle("command:echo-now", async () => {
    const text = await now();
    context.log.info(text);
    return { text };
  });
}
