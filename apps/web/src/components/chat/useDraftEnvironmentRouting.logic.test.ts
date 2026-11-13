import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  autoSelectionBlocker,
  autoSelectionNotes,
  environmentLoadWeight,
} from "./useDraftEnvironmentRouting.logic";

const environmentOf = (
  machine: "laptop" | "server",
  environmentIcon?: "laptop",
  loadBalancingWeight?: number,
) => ({
  serverConfig: {
    environment: { platform: { os: "linux" as const, arch: "x64" as const, machine } },
    settings: {
      environmentIcon: environmentIcon ?? null,
      loadBalancingWeight: loadBalancingWeight ?? null,
    },
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

  it("takes the weight the machine declares, below the client's pick", () => {
    expect(environmentLoadWeight(environmentOf("laptop", undefined, 80), undefined)).toBe(80);
    expect(environmentLoadWeight(environmentOf("laptop", undefined, 0), undefined)).toBe(0);
    expect(environmentLoadWeight(environmentOf("server", undefined, 0), 30)).toBe(30);
    expect(environmentLoadWeight(environmentOf("server", undefined, 80), 0)).toBe(0);
  });
});

describe("autoSelectionBlocker", () => {
  const codex = ProviderDriverKind.make("codex");
  const claude = ProviderDriverKind.make("claudeAgent");
  const instance = ProviderInstanceId.make("codex");
  const ready = {
    instanceId: instance,
    driver: codex,
    enabled: true,
    installed: true,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
  };
  const candidate = {
    connected: true,
    weight: 50,
    holdsReferencedThreadContexts: true,
    providers: [ready],
    activeProviderInstanceId: null,
    selectedProvider: codex,
  };

  it("lets a connected, weighted machine with a usable provider be chosen", () => {
    expect(autoSelectionBlocker(candidate)).toBeNull();
    expect(autoSelectionBlocker({ ...candidate, activeProviderInstanceId: instance })).toBeNull();
  });

  it.each([
    ["is not connected", { connected: false }, "Not connected"],
    ["has weight zero", { weight: 0 }, "Manual only (weight 0)"],
    [
      "is not where the referenced thread contexts are",
      { holdsReferencedThreadContexts: false },
      "Thread context is on another machine",
    ],
    ["lists no providers", { providers: undefined }, "Provider isn't installed here"],
    [
      "lists only another provider",
      { providers: [{ ...ready, driver: claude }] },
      "Provider isn't installed here",
    ],
    [
      "lists only another instance when one is asked for",
      {
        providers: [{ ...ready, instanceId: ProviderInstanceId.make("codex_personal") }],
        activeProviderInstanceId: instance,
      },
      "Provider isn't installed here",
    ],
    [
      "has the provider not installed",
      { providers: [{ ...ready, installed: false }] },
      "Provider isn't installed here",
    ],
    [
      "has the provider disabled for the project",
      { providers: [{ ...ready, enabled: false }] },
      "Provider is disabled for this project",
    ],
    [
      "has the provider in error",
      { providers: [{ ...ready, status: "error" as const }] },
      "Provider reports an error",
    ],
    [
      "has the provider signed out",
      { providers: [{ ...ready, auth: { status: "unauthenticated" as const } }] },
      "Provider isn't signed in",
    ],
    [
      "has the provider unavailable",
      { providers: [{ ...ready, availability: "unavailable" as const }] },
      "Provider is unavailable",
    ],
  ])("says why a machine that %s is left out", (_name, change, reason) => {
    expect(autoSelectionBlocker({ ...candidate, ...change })).toBe(reason);
  });

  it("names the first unmet condition", () => {
    expect(
      autoSelectionBlocker({
        ...candidate,
        connected: false,
        weight: 0,
        holdsReferencedThreadContexts: false,
        providers: undefined,
      }),
    ).toBe("Not connected");
    expect(
      autoSelectionBlocker({
        ...candidate,
        weight: 0,
        holdsReferencedThreadContexts: false,
        providers: undefined,
      }),
    ).toBe("Manual only (weight 0)");
    expect(
      autoSelectionBlocker({ ...candidate, holdsReferencedThreadContexts: false, providers: [] }),
    ).toBe("Thread context is on another machine");
    expect(
      autoSelectionBlocker({
        ...candidate,
        providers: [{ ...ready, installed: false, enabled: false, status: "error" as const }],
      }),
    ).toBe("Provider isn't installed here");
  });

  it("keeps a machine whose other instance of the provider is usable", () => {
    expect(
      autoSelectionBlocker({
        ...candidate,
        providers: [
          { ...ready, enabled: false },
          { ...ready, instanceId: ProviderInstanceId.make("codex_personal") },
        ],
      }),
    ).toBeNull();
  });
});

describe("autoSelectionNotes", () => {
  const environment = (
    environmentId: string,
    label: string,
    weight: number,
    blocker: string | null = null,
  ) => ({ environmentId, label, weight, blocker });
  const box = environment("environment-box", "Box", 50);

  it("only says where it runs when no machine has a higher weight", () => {
    expect(
      autoSelectionNotes("environment-box", [
        box,
        environment("environment-lap", "Lap", 50, "Not connected"),
      ]),
    ).toEqual(["Running on Box"]);
    expect(autoSelectionNotes("environment-box", [box])).toEqual(["Running on Box"]);
  });

  it("names a heavier machine that was left out, with its reason", () => {
    expect(
      autoSelectionNotes("environment-box", [
        box,
        environment("environment-lap", "Lap", 100, "Provider isn't signed in"),
      ]),
    ).toEqual(["Running on Box", "Lap skipped: Provider isn't signed in"]);
  });

  it("lists several skipped machines heaviest first", () => {
    expect(
      autoSelectionNotes("environment-box", [
        box,
        environment("environment-lap", "Lap", 60, "Not connected"),
        environment("environment-den", "Den", 100, "Provider is unavailable"),
      ]),
    ).toEqual([
      "Running on Box",
      "Den skipped: Provider is unavailable",
      "Lap skipped: Not connected",
    ]);
  });

  it("leaves out a heavier machine that was merely busier, and any lighter skipped one", () => {
    expect(
      autoSelectionNotes("environment-box", [
        box,
        environment("environment-lap", "Lap", 100),
        environment("environment-den", "Den", 25, "Not connected"),
      ]),
    ).toEqual(["Running on Box"]);
  });

  it("never lists the chosen machine itself", () => {
    expect(
      autoSelectionNotes("environment-box", [
        environment("environment-box", "Box", 50, "Not connected"),
      ]),
    ).toEqual(["Running on Box"]);
    expect(autoSelectionNotes("environment-gone", [box])).toEqual([]);
  });
});
