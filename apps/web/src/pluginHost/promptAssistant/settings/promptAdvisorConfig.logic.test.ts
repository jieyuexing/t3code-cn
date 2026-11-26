import { describe, expect, it } from "vite-plus/test";

import {
  choicesWith,
  configFailureMessage,
  DEFAULT_SESSION_SPRITE_CONFIG,
  describeRan,
  describeRoleStatus,
  describeSlotSharing,
  formatKeywordsInput,
  fromSelectValue,
  MAX_SPRITE_BLOCKED_KEYWORDS,
  MAX_SPRITE_KEYWORD_CHARS,
  numberChoicesWith,
  parseKeywordsInput,
  parsePromptAdvisorFailure,
  parsePromptAdvisorPayload,
  parsePromptAdvisorTestRun,
  parseSessionSpriteLedger,
  parseSessionSpriteScan,
  promptAdvisorUrl,
  sameConfig,
  PROMPT_ADVISOR_PATHS,
  type PromptAdvisorConfig,
  type RoleStatus,
  toSelectValue,
  withAdvisorText,
  withFollow,
  withLens,
  withModeOverride,
  withRuntime,
  withSprite,
} from "./promptAdvisorConfig.logic";
import {
  advisorPayload,
  DEFAULT_CONFIG,
  roleStatus,
  spriteLedgerEntry,
  spriteLedgerPayload,
  spriteLedgerSummary,
} from "./promptAdvisorSettings.testing";

const RAN = {
  resolvedInstanceId: "antigravity",
  activeModel: "gemini-4-neon",
  activeThinking: "low",
};

describe("parsePromptAdvisorPayload", () => {
  it("accepts the full server payload", () => {
    expect(parsePromptAdvisorPayload(advisorPayload())).toEqual(advisorPayload());
  });

  it("rejects anything missing a piece the page relies on", () => {
    const valid = advisorPayload();
    for (const broken of [
      null,
      "text",
      {},
      { ...valid, config: { ...valid.config, version: 2 } },
      { ...valid, status: { ...valid.status, advisor: { ...valid.status.advisor, state: "hot" } } },
      { ...valid, previews: { advisorPromptPreview: "x" } },
      { ...valid, defaults: undefined },
    ]) {
      expect(parsePromptAdvisorPayload(broken)).toBeNull();
    }
  });
});

describe("test run and failure bodies", () => {
  it("reads advisor items and a refined draft", () => {
    const status = advisorPayload().status;
    expect(
      parsePromptAdvisorTestRun({
        role: "advisor",
        durationMs: 800,
        draft: false,
        ran: RAN,
        items: [{ kind: "next", label: "复现", fill: "先复现" }],
        status,
      })?.items,
    ).toEqual([{ kind: "next", label: "复现", fill: "先复现" }]);
    expect(
      parsePromptAdvisorTestRun({
        role: "refiner",
        durationMs: 1,
        draft: true,
        ran: RAN,
        refined: "改写",
        status,
      })?.refined,
    ).toBe("改写");
    expect(
      parsePromptAdvisorTestRun({
        role: "advisor",
        durationMs: "slow",
        draft: false,
        ran: RAN,
        status,
      }),
    ).toBeNull();
    expect(
      parsePromptAdvisorTestRun({
        role: "advisor",
        durationMs: 1,
        draft: false,
        ran: RAN,
        items: [{ kind: "x" }],
        status,
      }),
    ).toBeNull();
    expect(parsePromptAdvisorTestRun({ role: "advisor", durationMs: 1, status })).toBeNull();
  });

  it("keeps the server's reason and status, and tolerates anything else", () => {
    const status = advisorPayload().status;
    expect(parsePromptAdvisorFailure({ error: "timed out", status })).toEqual({
      error: "timed out",
      status,
    });
    expect(parsePromptAdvisorFailure("nope")).toEqual({});
    expect(parsePromptAdvisorFailure(null)).toEqual({});
  });
});

describe("config edits", () => {
  const base: PromptAdvisorConfig = DEFAULT_CONFIG;

  it("changes only the field it names", () => {
    expect(withLens(base, "debugging", false).advisor.lenses).toEqual({
      grilling: true,
      debugging: false,
      blastRadius: true,
    });
    expect(withFollow(base, false).refiner.followAdvisorRuntime).toBe(false);
    expect(withAdvisorText(base, "customAppendix", "多问回归").advisor).toMatchObject({
      customAppendix: "多问回归",
      promptOverride: "",
    });
    expect(withModeOverride(base, "bold", "只发散").refiner.modeOverrides).toEqual({
      structured: "",
      bold: "只发散",
      scoped: "",
    });
  });

  it("keeps the two roles' runtimes apart", () => {
    const advisorOnly = withRuntime(base, "advisor", { model: "gemini-4-neon" });
    expect(advisorOnly.advisor.runtime.model).toBe("gemini-4-neon");
    expect(advisorOnly.refiner.runtime.model).toBeNull();
    const refinerOnly = withRuntime(base, "refiner", { thinking: "high" });
    expect(refinerOnly.refiner.runtime.thinking).toBe("high");
    expect(refinerOnly.advisor.runtime.thinking).toBeNull();
    expect(base.advisor.runtime.model).toBeNull();
  });
});

describe("select helpers", () => {
  it("turns automatic into a sentinel and back", () => {
    expect(fromSelectValue(toSelectValue(null))).toBeNull();
    expect(fromSelectValue(toSelectValue("gemini-4-neon"))).toBe("gemini-4-neon");
  });

  it("keeps a saved choice the helper no longer offers visible", () => {
    expect(choicesWith(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(choicesWith(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(choicesWith(["a"], null)).toEqual(["a"]);
  });
});

describe("status text", () => {
  const status = (patch: Partial<RoleStatus>): RoleStatus => ({ ...roleStatus(), ...patch });

  it("says where the numbers come from", () => {
    expect(
      describeRoleStatus(
        status({
          state: "warm",
          resolvedInstanceId: "antigravity",
          activeModel: "gemini-4-neon",
          activeThinking: "low",
          modelSource: "live",
          uses: 3,
          lastDurationMs: 1_234,
        }),
      ),
    ).toBe("Warm · antigravity · gemini-4-neon / low (measured) · reused 3/20 · last 1.2s");
    expect(
      describeRoleStatus(
        status({ state: "idle", activeModel: null, activeThinking: null, modelSource: "preset" }),
      ),
    ).toBe("Idle, starts on demand · antigravity · auto / auto (preset) · reused 0/20");
    expect(describeRoleStatus(status({ state: "unavailable" }))).toBe("Unavailable");
  });

  it("tells whether the refiner shares a process", () => {
    expect(describeSlotSharing(status({ sharesSlot: true }))).toContain("Shares");
    expect(describeSlotSharing(status({ sharesSlot: false }))).toContain("own warm process");
  });
});

describe("draft comparison and where a run ran", () => {
  it("compares configs by content, not key order", () => {
    const reordered: PromptAdvisorConfig = JSON.parse(
      JSON.stringify({
        sprite: DEFAULT_CONFIG.sprite,
        refiner: DEFAULT_CONFIG.refiner,
        advisor: DEFAULT_CONFIG.advisor,
        version: 1,
      }),
    );
    expect(sameConfig(DEFAULT_CONFIG, reordered)).toBe(true);
    expect(sameConfig(DEFAULT_CONFIG, withLens(DEFAULT_CONFIG, "debugging", false))).toBe(false);
    expect(sameConfig(DEFAULT_CONFIG, withAdvisorText(DEFAULT_CONFIG, "customAppendix", "x"))).toBe(
      false,
    );
  });

  it("names the instance, model and thinking level a run used", () => {
    expect(describeRan(RAN)).toBe("antigravity · gemini-4-neon / low");
    expect(describeRan({ resolvedInstanceId: null, activeModel: null, activeThinking: null })).toBe(
      "auto / auto",
    );
  });
});

describe("urls and failures", () => {
  it("appends the media ticket as a query", () => {
    expect(
      promptAdvisorUrl(
        { httpBase: "http://host", query: { wsTicket: "t1" } },
        PROMPT_ADVISOR_PATHS.config,
      ),
    ).toBe("http://host/prompt-advisor/config?wsTicket=t1");
    expect(promptAdvisorUrl({ httpBase: "/api/cn", query: {} }, PROMPT_ADVISOR_PATHS.testRun)).toBe(
      "/api/cn/prompt-advisor/test-run",
    );
  });

  it("explains each status in plain words", () => {
    expect(configFailureMessage(401)).toContain("Session expired");
    expect(configFailureMessage(403)).toContain("permission");
    expect(configFailureMessage(400)).toContain("rejected");
    expect(configFailureMessage(503)).toContain("No prompt advisor available");
    expect(configFailureMessage(500)).toBe("Request failed (500).");
  });
});

describe("session sprite config, ledger and keywords", () => {
  it("fills default sprite settings when a server payload omits sprite, and rejects invalid sprite values", () => {
    const valid = advisorPayload();
    const { sprite: _omitted, ...legacyConfig } = valid.config;
    const { sprite: _omittedDefault, ...legacyDefaults } = valid.defaults;
    expect(
      parsePromptAdvisorPayload({
        ...valid,
        config: legacyConfig,
        defaults: legacyDefaults,
      })?.config.sprite,
    ).toEqual(DEFAULT_SESSION_SPRITE_CONFIG);

    for (const badSprite of [
      null,
      { ...DEFAULT_SESSION_SPRITE_CONFIG, mode: "auto" },
      { ...DEFAULT_SESSION_SPRITE_CONFIG, scanIntervalMinutes: 1 },
      { ...DEFAULT_SESSION_SPRITE_CONFIG, idleMinutes: 99 },
      { ...DEFAULT_SESSION_SPRITE_CONFIG, maxPerThreadPerHumanTurn: 3 },
      { ...DEFAULT_SESSION_SPRITE_CONFIG, blockedTitleKeywords: [""] },
    ]) {
      expect(
        parsePromptAdvisorPayload({
          ...valid,
          config: { ...valid.config, sprite: badSprite },
        }),
      ).toBeNull();
    }
  });

  it("parses session sprite ledger and scan payloads and rejects malformed entries", () => {
    const ledger = spriteLedgerPayload();
    expect(parseSessionSpriteLedger(ledger)).toEqual(ledger);
    expect(
      parseSessionSpriteLedger({
        ...ledger,
        entries: [{ ...spriteLedgerEntry(), mode: "auto" }],
      }),
    ).toBeNull();

    const scan = {
      scanned: 2,
      wouldAdvance: 1,
      blocked: 1,
      errors: 0,
      summary: spriteLedgerSummary({ totalEvaluated: 2, blockedItems: 1 }),
      entries: [spriteLedgerEntry()],
    };
    expect(parseSessionSpriteScan(scan)).toEqual(scan);
    expect(parseSessionSpriteScan({ ...scan, scanned: "two" })).toBeNull();
  });

  it("updates only sprite fields via withSprite", () => {
    const updated = withSprite(DEFAULT_CONFIG, { enabled: true, scanIntervalMinutes: 15 });
    expect(updated.sprite.enabled).toBe(true);
    expect(updated.sprite.scanIntervalMinutes).toBe(15);
    expect(updated.sprite.idleMinutes).toBe(DEFAULT_CONFIG.sprite.idleMinutes);
    expect(updated.advisor).toEqual(DEFAULT_CONFIG.advisor);
    expect(DEFAULT_CONFIG.sprite.enabled).toBe(false);
  });

  it("parses, deduplicates, trims and bounds blocked keywords", () => {
    expect(parseKeywordsInput("  GWH-, NSNET-\n141，GWH-\n\n  work  ")).toEqual([
      "GWH-",
      "NSNET-",
      "141",
      "work",
    ]);
    const overLong = "a".repeat(MAX_SPRITE_KEYWORD_CHARS + 10);
    const dupAfterSlice = "a".repeat(MAX_SPRITE_KEYWORD_CHARS);
    expect(parseKeywordsInput(`${overLong}\n${dupAfterSlice}`)).toEqual([
      "a".repeat(MAX_SPRITE_KEYWORD_CHARS),
    ]);
    const many = Array.from({ length: MAX_SPRITE_BLOCKED_KEYWORDS + 10 }, (_, idx) => `kw-${idx}`);
    expect(parseKeywordsInput(many.join(","))).toHaveLength(MAX_SPRITE_BLOCKED_KEYWORDS);
    expect(formatKeywordsInput(["GWH-", "141"])).toBe("GWH-\n141");
    expect(numberChoicesWith([5, 10, 15], 12)).toEqual([5, 10, 12, 15]);
  });

  it("builds urls for sprite ledger and scan paths", () => {
    expect(
      promptAdvisorUrl(
        { httpBase: "/api/cn", query: { wsTicket: "t2" } },
        PROMPT_ADVISOR_PATHS.spriteLedger,
      ),
    ).toBe("/api/cn/prompt-advisor/sprite/ledger?wsTicket=t2");
    expect(
      promptAdvisorUrl({ httpBase: "/api/cn", query: {} }, PROMPT_ADVISOR_PATHS.spriteScan),
    ).toBe("/api/cn/prompt-advisor/sprite/scan");
  });
});
