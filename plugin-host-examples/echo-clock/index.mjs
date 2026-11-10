export async function activate(context) {
  const now = async () =>
    `${(await context.settings.get("prefix")) ?? "Now"}: ${new Date().toISOString()}`;
  context.handle("echo", (input) => input);
  context.handle("remember", ({ key, value }) => context.storage.set(key, value));
  context.handle("recall", ({ key }) => context.storage.get(key));
  context.handle("view:clock:now", async () => ({ text: await now() }));
  context.handle("command:echo-now", async () => {
    const text = await now();
    context.log.info(text);
    return { text };
  });
}
