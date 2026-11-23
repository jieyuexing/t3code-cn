import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("sends only changed ACP instruction sections on mode or capability transitions", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const initial = t3AcpPromptWithInstructions({ prompt: "Hi.", state });
    assert.include(initial, "T3 Code interaction mode: Default");
    assert.include(initial, "## T3 Code browser");
    assert.include(initial, "T3 Code orchestration");
    assert.include(initial, "ACP fallback:");
    assert.notInclude(initial, "## T3 Code devices");

    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );

    const switchedToPlan = t3AcpPromptWithInstructions({
      prompt: "Plan this.",
      state: { ...state, interactionMode: "plan" },
      previousState: state,
    });
    assert.include(switchedToPlan, "T3 Code interaction mode: Plan");
    assert.notInclude(switchedToPlan, "## T3 Code browser");
    assert.notInclude(switchedToPlan, "T3 Code orchestration");
    assert.notInclude(switchedToPlan, "ACP fallback:");

    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(withDevices, "T3 Code interaction mode:");
    assert.notInclude(withDevices, "## T3 Code browser");
    assert.notInclude(withDevices, "T3 Code orchestration");
    assert.notInclude(withDevices, "ACP fallback:");

    const gainedMcp = t3AcpPromptWithInstructions({
      prompt: "Use T3 tools.",
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true },
      previousState: { interactionMode: "default", hasT3Mcp: false, hasDeviceTools: false },
    });
    assert.notInclude(gainedMcp, "T3 Code interaction mode:");
    assert.include(gainedMcp, "## T3 Code browser");
    assert.include(gainedMcp, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.include(gainedMcp, "T3 Code orchestration");
    assert.include(gainedMcp, "ACP fallback:");

    assert.equal(
      t3AcpPromptWithInstructions({
        prompt: "No devices now.",
        state,
        previousState: { ...state, hasDeviceTools: true },
      }),
      "No devices now.",
    );
  });
});
