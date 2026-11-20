import { Context } from "cordis";

// Plugins import Cordis from here, so the version pinned in package.json is the only copy they run on.
export * from "cordis";

// Cordis `FiberState.ACTIVE`; the enum is erased from the published package.
const ACTIVE = 2;

/**
 * Wraps a Cordis plugin (a `Service` class or a plugin object) as a T3 plugin entry:
 * `export const { activate, deactivate } = cordisPlugin(MyPlugin)`.
 */
export function cordisPlugin(plugin, config) {
  let fiber;

  const activate = async (host) => {
    const root = new Context();
    for (const [name, service] of Object.entries(host.services ?? {})) root.provide(name, service);
    root.provide("t3", host);
    fiber = root.plugin(plugin, config);
    try {
      await fiber;
      if (fiber.state !== ACTIVE) {
        const missing = Object.keys(fiber.inject).filter((name) => root.get(name) === undefined);
        throw new Error(
          missing.length > 0
            ? `The Cordis plugin is waiting for services nobody provides: ${missing.join(", ")}.`
            : "The Cordis plugin did not become active.",
        );
      }
      for (const { name, methods } of host.provides ?? []) {
        const service = root.get(name);
        if (service === undefined)
          throw new Error(`The Cordis plugin did not provide the service ${name}.`);
        const notFunctions = methods.filter((method) => typeof service[method] !== "function");
        if (notFunctions.length > 0)
          throw new Error(`The service ${name} has no function for: ${notFunctions.join(", ")}.`);
        host.provide(
          name,
          Object.fromEntries(
            methods.map((method) => [method, (input, meta) => service[method](input, meta)]),
          ),
        );
      }
    } catch (error) {
      await fiber.dispose();
      fiber = undefined;
      throw error;
    }
  };

  const deactivate = async () => {
    await fiber?.dispose();
    fiber = undefined;
  };

  return { activate, deactivate };
}
