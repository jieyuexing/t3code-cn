import type { ReviewDiffFileStat } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { splitPath, statusLetter } from "./gitLog.logic";

it("maps a file's change type to its status letter", () => {
  const file = (changeType?: ReviewDiffFileStat["changeType"]) =>
    ({
      path: "a",
      previousPath: null,
      additions: 0,
      deletions: 0,
      changeType,
    }) as ReviewDiffFileStat;
  expect(
    (["new", "deleted", "change", "rename-pure", "rename-changed", undefined] as const).map(
      (type) => statusLetter(file(type)),
    ),
  ).toEqual(["A", "D", "M", "R", "R", "M"]);
});

it("splits a path into name and directory", () => {
  expect(splitPath("src/view/Log.tsx")).toEqual(["Log.tsx", "src/view"]);
  expect(splitPath("README.md")).toEqual(["README.md", ""]);
});
