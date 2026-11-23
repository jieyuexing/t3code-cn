import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { liveStepDigest } from "./liveStepDigest-cn";

const base = { createdAt: "2026-11-23T10:00:00.000Z", toolLifecycleStatus: "completed" } as const;

const read = (id: string): WorkLogEntry => ({
  ...base,
  id,
  label: "Read",
  tone: "tool",
  itemType: "dynamic_tool",
  toolTitle: "Read",
  toolData: { toolName: "Read" },
});

const run = (id: string, command: string): WorkLogEntry => ({
  ...base,
  id,
  label: "Ran command",
  tone: "tool",
  itemType: "command_execution",
  command,
});

const thought = (id: string): WorkLogEntry => ({
  ...base,
  id,
  label: "Thinking",
  tone: "thinking",
  itemType: "reasoning",
  detail: "Checking the failing test.",
});

describe("liveStepDigest", () => {
  it("tallies the tool calls by kind and leaves reasoning out", () => {
    const tools = [
      read("r1"),
      read("r2"),
      read("r3"),
      run("c1", "vp test run a.test.ts"),
      run("c2", "git status"),
    ];
    const entries = [thought("t1"), ...tools.slice(0, 3), thought("t2"), ...tools.slice(3)];
    expect(liveStepDigest(entries)).toBe(summarizeToolGroup(tools).summary);
  });

  it("stays silent while one call or only reasoning is on screen", () => {
    expect(liveStepDigest([])).toBeNull();
    expect(liveStepDigest([thought("t1"), thought("t2")])).toBeNull();
    expect(liveStepDigest([thought("t1"), run("c1", "vp test")])).toBeNull();
  });

  it("counts a call still in progress", () => {
    const running = { ...run("c2", "vp test"), toolLifecycleStatus: "inProgress" } as const;
    expect(liveStepDigest([read("r1"), running])).toBe(
      summarizeToolGroup([read("r1"), running]).summary,
    );
  });
});
