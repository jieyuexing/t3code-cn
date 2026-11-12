import { describe, expect, it } from "vite-plus/test";

import { childEnvironment } from "./PluginProcess.ts";

const BASE = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  LANG: "zh_CN.UTF-8",
  ANTHROPIC_API_KEY: "secret",
  T3CODE_DEV_AUTH_TOKEN: "secret",
};

describe("childEnvironment", () => {
  it("keeps the fixed keys and the environment's proxies, and nothing else", () => {
    const environment = childEnvironment({
      ...BASE,
      HTTP_PROXY: "http://127.0.0.1:2080",
      HTTPS_PROXY: "http://127.0.0.1:2080",
      NO_PROXY: "localhost,.ts.net",
    });
    expect(environment).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "zh_CN.UTF-8",
      HTTP_PROXY: "http://127.0.0.1:2080",
      HTTPS_PROXY: "http://127.0.0.1:2080",
      NO_PROXY: "localhost,.ts.net",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.T3CODE_DEV_AUTH_TOKEN).toBeUndefined();
  });

  it("adds no proxy and no flag when the server has none", () => {
    const environment = childEnvironment(BASE);
    expect(environment.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(environment.HTTP_PROXY).toBeUndefined();
  });

  it("recognizes the lower-case proxy variables too", () => {
    const environment = childEnvironment({ ...BASE, https_proxy: "http://127.0.0.1:7890" });
    expect(environment.https_proxy).toBe("http://127.0.0.1:7890");
    expect(environment.NODE_USE_ENV_PROXY).toBe("1");
  });
});
