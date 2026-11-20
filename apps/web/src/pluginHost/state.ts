import { createPluginHostEnvironmentAtoms } from "@t3tools/client-runtime/state/plugin-host";

import { connectionAtomRuntime } from "../connection/runtime";

export const pluginHostEnvironment = createPluginHostEnvironmentAtoms(connectionAtomRuntime);
