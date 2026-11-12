import { describe, expect, it } from "vite-plus/test";

import {
  cliReleaseAssetUrl,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "./cliRelease.ts";

const version = "1.2.4-nightly.20260912.7";

describe("fork release source", () => {
  it("downloads from the fork's own releases under its zh-v tags", () => {
    expect(cliReleaseAssetUrl(version, "SHA256SUMS")).toBe(
      `https://github.com/jieyuexing/t3code-zh/releases/download/zh-v${version}/SHA256SUMS`,
    );
    expect(cliReleaseDownloadBaseUrl(version)).toBe(
      `https://github.com/jieyuexing/t3code-zh/releases/download/zh-v${version}`,
    );
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/jieyuexing/t3code-zh/releases?per_page=100&page=2",
    );
  });

  it("keeps upstream's v tags on a mirror or a configured base URL", () => {
    expect(cliReleaseAssetUrl(version, "SHA256SUMS", "https://mirror.example/t3/")).toBe(
      `https://mirror.example/t3/v${version}/SHA256SUMS`,
    );
    expect(cliReleaseDownloadBaseUrl(version, "https://mirror.example/t3/")).toBe(
      `https://mirror.example/t3/v${version}`,
    );
  });

  it("reads versions from zh-v tags and skips revisions of a version", () => {
    expect(
      newestCliReleaseVersion(
        [{ tag_name: `zh-v${version}-r1` }, { tag_name: `zh-v${version}` }],
        "nightly",
      ),
    ).toBe(version);
    expect(newestCliReleaseVersion([{ tag_name: `zh-v${version}-r1` }], "stable")).toBeUndefined();
  });
});
