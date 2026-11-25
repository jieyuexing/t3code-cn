import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";

import { advisorPayload, advisorStatus, DEFAULT_CONFIG } from "./promptAdvisorSettings.testing";

const access = vi.hoisted(() => ({ readAccess: vi.fn() }));
vi.mock("../refiner/promptRefinerClient", () => ({ readAccess: access.readAccess }));

import {
  loadPromptAdvisorConfig,
  runPromptAdvisorTest,
  savePromptAdvisorConfig,
} from "./promptAdvisorConfigClient";

const ENVIRONMENT = "environment-a" as EnvironmentId;
const ticket = (value: string) => ({
  httpBase: "http://host",
  query: { wsTicket: value },
  credentials: false,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  access.readAccess.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const signal = () => new AbortController().signal;

describe("prompt advisor client", () => {
  it("loads the config with the ticket in the query", async () => {
    access.readAccess.mockResolvedValue(ticket("t1"));
    fetchMock.mockResolvedValue(json(200, advisorPayload()));
    const outcome = await loadPromptAdvisorConfig(ENVIRONMENT, signal());
    expect(outcome).toEqual({ ok: true, value: advisorPayload() });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://host/prompt-advisor/config?wsTicket=t1");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("renews an expired ticket once and then succeeds", async () => {
    access.readAccess.mockResolvedValueOnce(ticket("old")).mockResolvedValueOnce(ticket("new"));
    fetchMock
      .mockResolvedValueOnce(json(401, { error: "expired" }))
      .mockResolvedValueOnce(json(200, advisorPayload()));
    const outcome = await loadPromptAdvisorConfig(ENVIRONMENT, signal());
    expect(outcome.ok).toBe(true);
    expect(access.readAccess.mock.calls.map(([, refresh]) => refresh)).toEqual([false, true]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://host/prompt-advisor/config?wsTicket=old",
      "http://host/prompt-advisor/config?wsTicket=new",
    ]);
  });

  it("gives up after a second 401 with a session message", async () => {
    access.readAccess.mockResolvedValue(ticket("t"));
    fetchMock.mockResolvedValue(json(401, {}));
    const outcome = await loadPromptAdvisorConfig(ENVIRONMENT, signal());
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.ok === false && outcome.message).toContain("Session expired");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the whole config on save and reads back the new payload", async () => {
    access.readAccess.mockResolvedValue(ticket("t1"));
    const saved = advisorPayload({
      config: { ...DEFAULT_CONFIG, advisor: { ...DEFAULT_CONFIG.advisor, customAppendix: "新增" } },
    });
    fetchMock.mockResolvedValue(json(200, saved));
    const outcome = await savePromptAdvisorConfig(ENVIRONMENT, saved.config, signal());
    expect(outcome).toEqual({ ok: true, value: saved });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ config: saved.config });
  });

  it("shows the server's own reason when a test run fails and keeps its status", async () => {
    access.readAccess.mockResolvedValue(ticket("t1"));
    const status = advisorStatus();
    fetchMock.mockResolvedValue(json(502, { error: "Antigravity advisor timed out.", status }));
    const outcome = await runPromptAdvisorTest(
      ENVIRONMENT,
      { role: "advisor", scenario: "debugging" },
      signal(),
    );
    expect(outcome).toEqual({ ok: false, message: "Antigravity advisor timed out.", status });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      role: "advisor",
      scenario: "debugging",
    });
  });

  it("falls back to a status-based message when the failure has no reason", async () => {
    access.readAccess.mockResolvedValue(ticket("t1"));
    fetchMock.mockResolvedValue(new Response("<html>", { status: 403 }));
    const outcome = await savePromptAdvisorConfig(ENVIRONMENT, DEFAULT_CONFIG, signal());
    expect(outcome.ok === false && outcome.message).toContain("permission");
  });

  it("reports a missing connection, an unreachable server and an unreadable answer", async () => {
    access.readAccess.mockResolvedValueOnce(null);
    expect(await loadPromptAdvisorConfig(ENVIRONMENT, signal())).toMatchObject({
      ok: false,
      message: expect.stringContaining("Not connected"),
    });
    access.readAccess.mockResolvedValue(ticket("t"));
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await loadPromptAdvisorConfig(ENVIRONMENT, signal())).toMatchObject({
      ok: false,
      message: expect.stringContaining("Could not reach the server"),
    });
    fetchMock.mockResolvedValueOnce(json(200, { surprise: true }));
    expect(await loadPromptAdvisorConfig(ENVIRONMENT, signal())).toMatchObject({
      ok: false,
      message: expect.stringContaining("unrecognized"),
    });
  });

  it("lets an abort through instead of reporting it as a network failure", async () => {
    access.readAccess.mockResolvedValue(ticket("t"));
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(loadPromptAdvisorConfig(ENVIRONMENT, controller.signal)).rejects.toThrow();
  });
});
