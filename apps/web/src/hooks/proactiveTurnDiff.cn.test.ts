import type { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldOpenProactiveTurnDiff } from "../components/ChatView.logic";
import { observeProactiveTurnDiff } from "./proactiveTurnDiff.cn";

const r1 = "run-1" as RunId;
const r2 = "run-2" as RunId;

type Pass = { running: RunId | null; settled: RunId | null; holds: boolean };

// Feeds each pass the running turn the previous pass left behind, as the hook's effect does.
function opened(passes: ReadonlyArray<Pass>): Array<RunId | null> {
  let previous: RunId | null | undefined = undefined;
  return passes.map(({ running, settled, holds }) => {
    const step = observeProactiveTurnDiff({
      previousRunningTurnId: previous,
      runningTurnId: running,
      settledTurnId: settled,
      turnCompleted: settled !== null,
      backgroundWorkHolds: holds,
    });
    previous = step.nextRunningTurnId;
    return step.newlyCompletedTurnId;
  });
}

describe("observeProactiveTurnDiff", () => {
  it("opens a completed turn's diff right away when nothing holds it", () => {
    expect(
      opened([
        { running: r1, settled: null, holds: false },
        { running: null, settled: r1, holds: false },
      ]),
    ).toEqual([null, r1]);
  });

  it("waits for held background work, then opens the diff once", () => {
    // Upstream alone opens the panel the moment the turn completes, whatever still runs.
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: r1,
        runningTurnId: null,
        settledTurnId: r1,
        turnCompleted: true,
      }),
    ).toBe(true);
    expect(
      opened([
        { running: r1, settled: null, holds: false },
        { running: null, settled: r1, holds: true },
        { running: null, settled: r1, holds: true },
        { running: null, settled: r1, holds: false },
        { running: null, settled: r1, holds: false },
      ]),
    ).toEqual([null, null, null, r1, null]);
  });

  it("opens a woken run's own diff after the held turn", () => {
    expect(
      opened([
        { running: r1, settled: null, holds: false },
        { running: null, settled: r1, holds: true },
        { running: r2, settled: null, holds: false },
        { running: null, settled: r2, holds: false },
      ]),
    ).toEqual([null, null, null, r2]);
  });

  it("holds a thread's first sighting of a completed turn too", () => {
    expect(
      opened([
        { running: null, settled: r1, holds: true },
        { running: null, settled: r1, holds: false },
      ]),
    ).toEqual([null, r1]);
  });
});
