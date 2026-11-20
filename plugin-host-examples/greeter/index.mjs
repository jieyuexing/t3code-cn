export async function activate(context) {
  context.provide("example.greeter", {
    greet: async ({ name }) => ({
      greeting: `Hello, ${name}!`,
      clock: await context.services["example.clock"].now({}),
    }),
  });
}
