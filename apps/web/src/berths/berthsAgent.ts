import { createAgent, registerTools } from "@ui-sdk/react/agent";

let sharedAgent: ReturnType<typeof createAgent> | null = null;

/**
 * Registers the `/berths` ui-sdk primitives with WebMCP (`document.modelContext`) when supported
 * by the host browser. No-op in environments without WebMCP.
 */
export function registerBerthsWebMcp(): () => void {
  if (typeof document === "undefined" || !("modelContext" in document)) return () => {};
  sharedAgent ??= createAgent();
  return registerTools(sharedAgent, {
    allow: (step) => (step.confirm ? window.confirm(step.confirm) : true),
  });
}
