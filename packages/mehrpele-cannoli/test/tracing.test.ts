                                                                                                   
// bundle sends nothing to smith.langchain.com, nor to a LANGSMITH_ENDPOINT on 127.0.0.1 (which a
// direct global fetch, bypassing the shim, would reach and count).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EgressEvent } from "../src/run/egress";
import { type Bundled, buildBundled } from "./support/bundled";
import { startFakeLlm } from "./support/fake-llm";
import { FAKE_KEY, fixture, HELLO } from "./support/runner";

const ENV: Record<string, string> = {
  LANGSMITH_TRACING: "true",
  LANGCHAIN_TRACING_V2: "true",
  LANGSMITH_TRACING_V2: "true",
  LANGSMITH_API_KEY: "fake-key-for-tests-cccc",
  LANGCHAIN_API_KEY: "fake-key-for-tests-cccc",
};

let B: Bundled;
const llm = startFakeLlm();
const smith = startFakeLlm();
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const env = { ...ENV, LANGSMITH_ENDPOINT: `http://127.0.0.1:${smith.port}`, LANGCHAIN_ENDPOINT: `http://127.0.0.1:${smith.port}` };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  B = await buildBundled("tracing");
}, 120_000);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  llm.stop();
  smith.stop();
});

describe("LangSmith tracing", () => {
  test("tracing env vars set: the run completes and nothing goes to LangSmith", async () => {
    expect(process.env.LANGSMITH_TRACING).toBe("true");
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true");
    const settings = B.normalizeSettings({
      providers: { openai_compatible: { baseUrl: llm.baseUrl, model: "fake-model" } },
      defaultProvider: "openai_compatible",
      network: { allowLocalhost: false },
    });
    const events: EgressEvent[] = [];
    const sent: string[] = [];
    const hostFetch = B.createHostFetch({
      getSettings: () => settings,
      transport: (url, init) => {
        sent.push(url);
        return globalThis.fetch(url, init);
      },
      onRequest: (e) => events.push(e),
    });
    const off = B.installEgress(hostFetch);
    try {
      const stop = await B.startRun(B.Run, {
        cannoli: JSON.parse(fixture(HELLO)),
        isMock: false,
        llmConfigs: [B.buildLlmConfig(settings, "openai_compatible", FAKE_KEY)] as never,
        fetcher: B.textFetcher(hostFetch),
      }).finished;
      expect(stop.reason).toBe("complete");
      // Trace batches flush asynchronously; give them time to show up.
      await Bun.sleep(500);
    } finally {
      off();
    }
    expect(llm.hits.length).toBeGreaterThan(0);
    expect(smith.hits).toEqual([]);
    const all = [...events.map((e) => e.url), ...sent].join("\n");
    expect(all).not.toMatch(/langchain\.com|smith/i);
    expect(events.every((e) => e.allowed && e.host === `127.0.0.1:${llm.port}`)).toBe(true);
  }, 30_000);
});
