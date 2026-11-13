import { describe, expect, it } from "vite-plus/test";

import { environmentLoadWeight } from "./useDraftEnvironmentRouting.logic";

const environmentOf = (machine: "laptop" | "server", environmentIcon?: "laptop") => ({
  serverConfig: {
    environment: { platform: { os: "linux" as const, arch: "x64" as const, machine } },
    settings: { environmentIcon: environmentIcon ?? null },
  },
});

describe("environmentLoadWeight", () => {
  it("uses the kind the machine reports, or the icon the user picked for it", () => {
    expect(environmentLoadWeight(environmentOf("server"), undefined)).toBe(100);
    expect(environmentLoadWeight(environmentOf("laptop"), undefined)).toBe(50);
    expect(environmentLoadWeight(environmentOf("server", "laptop"), undefined)).toBe(50);
  });

  it("is neutral until the machine's config has arrived", () => {
    expect(environmentLoadWeight({ serverConfig: null }, undefined)).toBe(50);
    expect(environmentLoadWeight(undefined, undefined)).toBe(50);
  });

  it("keeps the client's pick, including zero", () => {
    expect(environmentLoadWeight(environmentOf("server"), 25)).toBe(25);
    expect(environmentLoadWeight(environmentOf("server"), 0)).toBe(0);
  });
});
