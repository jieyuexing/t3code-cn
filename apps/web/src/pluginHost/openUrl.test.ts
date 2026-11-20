import { describe, expect, it } from "vite-plus/test";

import { openableUrl } from "./openUrl";

describe("openableUrl", () => {
  it("passes absolute http and https URLs through", () => {
    expect(openableUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(openableUrl("http://example.com/")).toBe("http://example.com/");
  });

  it("refuses every other protocol, relative paths and malformed input", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "mailto:someone@example.com",
      "ftp://example.com/feed",
      "/relative/path",
      "example.com",
      "",
      "not a url",
    ]) {
      expect(() => openableUrl(value)).toThrow();
    }
  });
});
