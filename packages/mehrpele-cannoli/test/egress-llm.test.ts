                                                                                               
// the fetch-shim inject), because unbundled the SDKs would use the global fetch directly.
// The provider is a fake OpenAI-compatible server on 127.0.0.1; allowLocalhost is off, so only
// the configured provider host:port is allowed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EgressEvent, RequestUrlParamLike, Transport } from "../src/run/egress";
import { type Bundled, buildBundled } from "./support/bundled";
import { electronRequestUrl, isBrowserForbidden } from "./support/electron-request-url";
import { FAKE_REPLY, startFakeLlm } from "./support/fake-llm";
import { FAKE_KEY, fixture, HELLO } from "./support/runner";

let B: Bundled;
const server = startFakeLlm();
const other = startFakeLlm();
beforeAll(async () => {
  B = await buildBundled("egress-llm");
}, 120_000);
afterAll(() => {
  server.stop();
  other.stop();
});

function setup(baseURL: string, transport: Transport = (url, init) => globalThis.fetch(url, init)) {
  const settings = B.normalizeSettings({
    providers: { openai_compatible: { baseUrl: server.baseUrl, model: "fake-model" } },
    defaultProvider: "openai_compatible",
    network: { allowLocalhost: false },
  });
  const events: EgressEvent[] = [];
  const sent: string[] = [];
  const hostFetch = B.createHostFetch({
    getSettings: () => settings,
    // The real network, reached only through this transport (as requestUrl is in Obsidian).
    transport: (url, init) => {
      sent.push(url);
      return transport(url, init);
    },
    onRequest: (e) => events.push(e),
  });
  const config = B.buildLlmConfig(settings, "openai_compatible", FAKE_KEY);
  config.baseURL = baseURL;
  const stray: string[] = [];
  // The vendored core's Run.error() rethrows after ending the run, from inside an EventTarget
  // listener, where the browser only reports it (Bun's test runner counts it as a failure). The
  // stoppage is already delivered through onFinish, so the test run records the throw instead.
  class TestRun extends B.Run {
    error(message: string): void {
      try {
        super.error(message);
      } catch (e) {
        stray.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  const run = () =>
    B.startRun(TestRun as typeof B.Run, {
      cannoli: JSON.parse(fixture(HELLO)),
      isMock: false,
      llmConfigs: [config] as never,
      fetcher: B.textFetcher(hostFetch),
    }).finished;
  return { hostFetch, events, sent, stray, run, config };
}

describe("LLM traffic through the built bundle", () => {
  test("a real (non-mock) run reaches the configured provider only through hostFetch", async () => {
    const s = setup(server.baseUrl);
    const off = B.installEgress(s.hostFetch);
    try {
      const before = server.hits.length;
      const stop = await s.run();
      expect(stop.reason).toBe("complete");
      const hits = server.hits.slice(before);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.path === "/v1/chat/completions" && h.auth === `Bearer ${FAKE_KEY}`)).toBe(true);
      // Every request the server saw was an allowed egress event, and nothing was denied.
      expect(s.events.length).toBe(hits.length);
      expect(s.events.every((e) => e.allowed && e.host === `127.0.0.1:${server.port}`)).toBe(true);
      expect(s.sent.length).toBe(hits.length);
      expect(s.stray).toEqual([]);
    } finally {
      off();
    }
  }, 30_000);

  test("the SDK reaches the provider through requestUrlTransport under Electron's header rule", async () => {
    // main.ts's real transport, over a requestUrl that rejects browser-controlled headers like
    // Electron does (the OpenAI SDK sets content-length; Obsidian then refuses the request).
    const seen: RequestUrlParamLike[] = [];
    const s = setup(server.baseUrl, B.requestUrlTransport(electronRequestUrl(seen)));
    const off = B.installEgress(s.hostFetch);
    try {
      const before = server.hits.length;
      const stop = await s.run();
      expect(s.stray).toEqual([]);
      expect(stop.reason).toBe("complete");
      const hits = server.hits.slice(before);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.auth === `Bearer ${FAKE_KEY}`)).toBe(true);
      expect(seen.length).toBe(hits.length);
      expect(seen.every((p) => !Object.keys(p.headers ?? {}).some(isBrowserForbidden))).toBe(true);
    } finally {
      off();
    }
  }, 30_000);

  test("streaming calls (chat arrows) take the same requestUrl path and survive the header rule", async () => {
    const seen: RequestUrlParamLike[] = [];
    const s = setup(server.baseUrl, B.requestUrlTransport(electronRequestUrl(seen)));
    const off = B.installEgress(s.hostFetch);
    try {
      const before = server.hits.length;
      const run = new B.Run({ cannoli: JSON.parse(fixture(HELLO)), isMock: false, llmConfigs: [s.config] as never });
      const stream = await run.callLLMStream({ messages: [{ role: "user", content: "hi" }] } as never);
      expect(stream).not.toBeInstanceOf(Error);
      let text = "";
      for await (const part of stream as AsyncIterable<unknown>) if (typeof part === "string") text += part;
      expect(text).toBe(FAKE_REPLY);
      const hits = server.hits.slice(before);
      expect(hits.length).toBe(1);
      expect((hits[0].body as { stream?: boolean }).stream).toBe(true);
      expect(seen.every((p) => !Object.keys(p.headers ?? {}).some(isBrowserForbidden))).toBe(true);
    } finally {
      off();
    }
  }, 30_000);

  test("without an installed egress the SDK cannot reach the server at all", async () => {
    const s = setup(server.baseUrl);
    const before = server.hits.length;
    const stop = await s.run();
    expect(stop.reason).toBe("error");
    expect(server.hits.length).toBe(before);
    expect(s.events).toEqual([]);
    expect(s.stray.every((m) => m.startsWith("Error calling LLM"))).toBe(true);
  }, 30_000);

  test("a baseURL on a host that is not allowed is blocked before any request", async () => {
    const s = setup(other.baseUrl);
    const off = B.installEgress(s.hostFetch);
    try {
      const stop = await s.run();
      expect(stop.reason).toBe("error");
      expect(other.hits).toHaveLength(0);
      expect(s.sent).toEqual([]);
      expect(s.events.length).toBeGreaterThan(0);
      expect(s.events.every((e) => !e.allowed && e.host === `127.0.0.1:${other.port}`)).toBe(true);
    } finally {
      off();
    }
  }, 30_000);
});
