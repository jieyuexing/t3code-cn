export async function activate(context) {
  const greet = async (name) => {
    const clock = await context.services["example.clock"].now();
    return { greeting: `Hello, ${name}!`, clock };
  };
  context.handle("greet", ({ name }) => greet(name));
  context.handle("command:greet-now", () => greet("there"));
}
