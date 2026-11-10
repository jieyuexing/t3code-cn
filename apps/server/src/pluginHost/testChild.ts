/** Starts the plugin child straight from source for tests, which have no CLI entrypoint to run `__plugin-host` on. */
export const CHILD = {
  command: process.execPath,
  args: [
    "--input-type=module",
    "-e",
    `import { runPluginChild } from ${JSON.stringify(new URL("./childRuntime.ts", import.meta.url).href)}; runPluginChild();`,
  ],
} as const;
