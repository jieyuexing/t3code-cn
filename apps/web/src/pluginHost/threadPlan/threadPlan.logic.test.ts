import { describe, expect, it } from "vite-plus/test";

import {
  formatPlanElapsed,
  groupPlanSteps,
  planProgress,
  planRows,
  previewPendingSteps,
  selectThreadPlan,
  type ThreadPlanSource,
} from "./threadPlan.logic";

type Plan = ThreadPlanSource["plans"][number];
type Step = Extract<Plan, { kind: "todo_list" }>["steps"][number];

const step = (id: string, status: Step["status"]): Step => ({ id, text: `Step ${id}`, status });
const todo = (
  id: string,
  runId: string | null,
  status: Plan["status"],
  steps: ReadonlyArray<Step> = [step("a", "pending")],
) => ({ id, runId, status, kind: "todo_list", steps }) as unknown as Plan;
const run = (id: string, ordinal: number, status = "completed") =>
  ({ id, ordinal, status }) as ThreadPlanSource["runs"][number];
const item = (planId: string, ordinal: number, type = "todo_list") => ({ type, planId, ordinal });
const source = (parts: Partial<ThreadPlanSource>): ThreadPlanSource => ({
  plans: [],
  runs: [],
  turnItems: [],
  ...parts,
});
const idOf = (selected: ReturnType<typeof selectThreadPlan>) => selected?.plan.id;

describe("selectThreadPlan", () => {
  it.each([
    {
      name: "the plan of the latest run, whatever the array order",
      plans: [todo("p2", "r2", "active"), todo("p1", "r1", "active")],
      runs: [run("r1", 1), run("r2", 2)],
      turnItems: [],
      expected: "p2",
    },
    {
      name: "the plan whose todo item is newest within one run",
      plans: [todo("p-b", "r1", "active"), todo("p-a", "r1", "active")],
      runs: [run("r1", 1)],
      turnItems: [item("p-a", 5), item("p-b", 3)],
      expected: "p-a",
    },
    {
      name: "a completed plan, until a newer one appears",
      plans: [todo("p1", "r1", "completed"), todo("p2", "r2", "active")],
      runs: [run("r1", 1), run("r2", 2)],
      turnItems: [],
      expected: "p2",
    },
    {
      name: "a completed plan when it is the newest",
      plans: [todo("p1", "r1", "active"), todo("p2", "r2", "completed")],
      runs: [run("r1", 1), run("r2", 2)],
      turnItems: [],
      expected: "p2",
    },
    {
      name: "never a superseded plan, even a newer one",
      plans: [todo("p1", "r1", "active"), todo("p2", "r2", "superseded")],
      runs: [run("r1", 1), run("r2", 2)],
      turnItems: [item("p2", 9)],
      expected: "p1",
    },
    {
      name: "the later plan when its todo item is outside the loaded window",
      plans: [todo("p1", "r1", "active"), todo("p2", "r1", "active")],
      runs: [run("r1", 1)],
      turnItems: [],
      expected: "p2",
    },
    {
      name: "a plan whose run is not loaded, after plans of known runs",
      plans: [todo("p1", "r1", "active"), todo("p2", "gone", "active")],
      runs: [run("r1", 1)],
      turnItems: [],
      expected: "p1",
    },
    {
      name: "nothing for a proposed plan only",
      plans: [{ id: "x", runId: "r1", status: "active", kind: "proposed_plan" } as unknown as Plan],
      runs: [run("r1", 1)],
      turnItems: [item("x", 1, "proposed_plan")],
      expected: undefined,
    },
    {
      name: "nothing when only superseded plans exist",
      plans: [todo("p1", "r1", "superseded")],
      runs: [run("r1", 1)],
      turnItems: [],
      expected: undefined,
    },
    {
      name: "nothing for an empty list",
      plans: [todo("p1", "r1", "active", [])],
      runs: [run("r1", 1)],
      turnItems: [],
      expected: undefined,
    },
  ])("picks $name", ({ expected, ...parts }) => {
    expect(idOf(selectThreadPlan(source(parts)))).toBe(expected);
  });

  it.each([
    ["running", true],
    ["waiting", true],
    ["completed", false],
    ["interrupted", false],
  ])("marks a plan of a %s run live=%s", (status, live) => {
    const selected = selectThreadPlan(
      source({ plans: [todo("p1", "r1", "active")], runs: [run("r1", 1, status)] }),
    );
    expect(selected?.live).toBe(live);
  });
});

describe("plan progress and grouping", () => {
  const steps = [
    step("1", "completed"),
    step("2", "completed"),
    step("3", "running"),
    step("4", "pending"),
    step("5", "pending"),
  ];

  it("counts done steps and names the running one as current", () => {
    expect(planProgress(todo("p", "r", "active", steps) as never)).toEqual({
      done: 2,
      total: 5,
      complete: false,
      currentStep: "Step 3",
    });
  });

  it("falls back to the first pending step between two running ones", () => {
    const groups = groupPlanSteps([step("1", "completed"), step("2", "pending")]);
    expect(groups.current?.id).toBe("2");
    expect(groups.running).toEqual([]);
  });

  it.each([
    { status: "completed", steps: [step("1", "completed"), step("2", "pending")], complete: true },
    { status: "active", steps: [step("1", "completed"), step("2", "completed")], complete: true },
    { status: "active", steps: [step("1", "completed"), step("2", "running")], complete: false },
  ] as const)(
    "is complete=$complete for $status with these steps",
    ({ status, steps: given, complete }) => {
      expect(planProgress(todo("p", "r", status, given) as never).complete).toBe(complete);
    },
  );

  it("previews five pending steps and lists all once expanded", () => {
    const pending = Array.from({ length: 8 }, (_, index) => step(String(index), "pending"));
    expect(previewPendingSteps(pending, false)).toMatchObject({ hidden: 3 });
    expect(previewPendingSteps(pending, false).shown).toHaveLength(5);
    expect(previewPendingSteps(pending, true)).toMatchObject({ hidden: 0 });
  });
});

describe("card densities and elapsed time", () => {
  it.each([
    ["full", { bar: true, current: true, lists: true }],
    ["compact", { bar: false, current: true, lists: false }],
    ["essential", { bar: false, current: false, lists: false }],
  ] as const)("keeps these rows at %s density", (density, rows) => {
    expect(planRows(density)).toEqual(rows);
  });

  it.each([
    [0, "<1m"],
    [59_000, "<1m"],
    [60_000, "1m"],
    [14 * 60_000 + 30_000, "14m"],
    [75 * 60_000, "1h 15m"],
    [-5_000, "<1m"],
    [Number.NaN, "<1m"],
  ])("formats %dms as %s", (elapsedMs, text) => {
    expect(formatPlanElapsed(elapsedMs)).toBe(text);
  });
});
