import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems, type ComposerThreadCandidate } from "./composerThreadItems.ts";
import { expandComposerThreadQuery } from "./composerThreadQuery.zh.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

function mentionIds(shells: ReadonlyArray<ComposerThreadCandidate>, query: string): string[] {
  return matchComposerThreadItems({
    shells,
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query,
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  }).map((item) => item.thread.threadId);
}

describe("composer thread mentions skip words", () => {
  it("finds a CJK title across a skipped word", () => {
    expect(mentionIds([shell("ink", "水墨同题 · Grok 4.7")], "水墨grok")).toEqual(["ink"]);
  });

  it("finds a CJK run written together across a word boundary", () => {
    expect(mentionIds([shell("cron", "定时任务追加GitHub监控")], "定时任务github")).toEqual([
      "cron",
    ]);
  });

  it("finds a CJK title whose words are not adjacent", () => {
    expect(mentionIds([shell("split", "抓取官方分成规则")], "抓取规则")).toEqual(["split"]);
  });

  it("finds a title when a number follows a word without a space", () => {
    expect(mentionIds([shell("pr", "Review PR 195")], "review195")).toEqual(["pr"]);
  });

  it("leaves the raw query's matches exactly as they were", () => {
    const shells = [shell("long", "定时任务追加GitHub监控"), shell("short", "定时任务")];
    expect(mentionIds(shells, "定时任务")).toEqual(["short", "long"]);
  });

  it("still needs every word when a query is expanded", () => {
    expect(
      mentionIds([shell("ink", "水墨同题 · Grok 4.7"), shell("brush", "水墨同题练习")], "水墨grok"),
    ).toEqual(["ink"]);
  });
});

describe("expandComposerThreadQuery", () => {
  it("cuts Chinese and Japanese runs into two-character words beside other scripts", () => {
    expect(expandComposerThreadQuery("水墨grok")).toBe("水墨 grok");
    expect(expandComposerThreadQuery("定时任务github")).toBe("定时 任务 github");
    expect(expandComposerThreadQuery("抓取规则")).toBe("抓取 规则");
    expect(expandComposerThreadQuery("grok水墨同题")).toBe("grok 水墨 同题");
  });

  it("leaves an odd Chinese run's last character on its own", () => {
    expect(expandComposerThreadQuery("抓取规")).toBe("抓取 规");
  });

  it("spaces letters and digits apart", () => {
    expect(expandComposerThreadQuery("review195")).toBe("review 195");
    expect(expandComposerThreadQuery("195review")).toBe("195 review");
  });

  it("leaves a query that already reads as these words alone", () => {
    expect(expandComposerThreadQuery("")).toBeNull();
    expect(expandComposerThreadQuery("grok")).toBeNull();
    expect(expandComposerThreadQuery("水墨")).toBeNull();
    expect(expandComposerThreadQuery("水墨 grok")).toBeNull();
  });

  it("keeps punctuation inside a word and off its end", () => {
    expect(expandComposerThreadQuery("grok4.7")).toBe("grok 4.7");
    expect(expandComposerThreadQuery("抓取规则：")).toBe("抓取 规则");
  });
});
