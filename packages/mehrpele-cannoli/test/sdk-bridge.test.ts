import { beforeAll, describe, expect, test } from "bun:test";
import type { LLMConfig, ModelFetch } from "@mehrpele/cannoli-core";
import { buildBundled, type Bundled } from "./support/bundled";

let B: Bundled;
beforeAll(async () => { B = await buildBundled("sdk-bridge"); }, 120_000);
const messages = [{ role: "user" as const, content: "hello" }];
const azure: LLMConfig = {
  provider: "azure_openai", model: "gpt-4o", apiKey: "fake-base-key",
  azureOpenAIApiDeploymentName: "actual-deploy", azureOpenAIApiInstanceName: "original",
  azureOpenAIApiVersion: "2024-06-01",
};
function capture() {
  const requests: { url: URL; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch: ModelFetch = async (input, init) => {
    requests.push({ url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (requests.at(-1)!.body.stream) {
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1,
        model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: "fake", object: "chat.completion", created: 1,
      model: "fake", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { headers: { "content-type": "application/json" } });
  };
  return { requests, fetch };
}
function run(config: LLMConfig, fetch?: ModelFetch) {
  return new B.Run({ cannoli: { nodes: [], edges: [] }, llmConfigs: [config], modelFetch: fetch });
}
describe("browser SDK compatibility", () => {
  test("Azure uses the configured deployment rather than the display model", async () => {
    const c = capture();
    expect(await run(azure, c.fetch).callLLM({ messages })).not.toBeInstanceOf(Error);
    expect(c.requests[0]!.url.pathname).toBe("/openai/deployments/actual-deploy/chat/completions");
  });
  test("Azure instance, deployment, version and credential overrides travel together", async () => {
    const c = capture();
    expect(await run(azure, c.fetch).callLLM({ messages, user: "attribution",
      azureOpenAIApiInstanceName: "override", azureOpenAIApiDeploymentName: "override-deploy",
      azureOpenAIApiVersion: "2025-01-01-preview", apiKey: "fake-override" })).not.toBeInstanceOf(Error);
    const r = c.requests[0]!;
    expect(r.url.hostname).toBe("override.openai.azure.com");
    expect(r.url.pathname).toBe("/openai/deployments/override-deploy/chat/completions");
    expect(r.url.searchParams.get("api-version")).toBe("2025-01-01-preview");
    expect(r.headers.get("api-key")).toBe("fake-override");
    expect(r.headers.has("authorization")).toBe(false);
    expect(r.body.user).toBe("attribution");
  });
  test("Azure preserves an explicit URL query version and other query values", async () => {
    const c = capture();
    await run({ ...azure, azureOpenAIApiVersion: undefined,
      baseURL: "https://resource.test/openai/deployments/old?api-version=2023-05-15&tenant=a&tenant=b" }, c.fetch).callLLM({ messages });
    expect(c.requests[0]!.url.searchParams.get("api-version")).toBe("2023-05-15");
    expect(c.requests[0]!.url.searchParams.getAll("tenant")).toEqual(["a", "b"]);
  });
  test("OpenAI preserves legacy user attribution", async () => {
    const c = capture();
    await run({ provider: "openai", model: "gpt-4o", apiKey: "fake", baseURL: "https://model.test/v1" }, c.fetch)
      .callLLM({ messages, user: "legacy-user" });
    expect(c.requests[0]!.body.user).toBe("legacy-user");
  });
  test("undefined secondary provider fields retain inherited defaults", () => {
    const p = new B.BridgeProvider({ configs: [
      { provider: "openai", model: "base", temperature: 0.7, apiKey: "fake" },
      { provider: "ollama", model: "local", temperature: undefined, apiKey: undefined },
    ] });
    expect(p.getMergedConfig({ provider: "ollama" })).toMatchObject({ temperature: 0.7, apiKey: "fake", model: "local" });
  });
  test("fallback generation retains the run transport over an installed host transport", async () => {
    const scoped = capture(), installed = capture();
    const off = B.installEgress(installed.fetch);
    try {
      const r = new B.Run({ cannoli: { nodes: [], edges: [] }, providerEngine: "langchain",
        llmConfigs: [{ provider: "openai", model: "fake", apiKey: "fake", baseURL: "https://model.test/v1" }],
        modelFetch: scoped.fetch });
      expect(await r.callLLM({ messages })).not.toBeInstanceOf(Error);
      expect(scoped.requests).toHaveLength(1);
      expect(installed.requests).toHaveLength(0);
    } finally { off(); }
  });
  test("cached SDK ports pick up rotated auth from the config resolver on the next call", async () => {
    const c = capture();
    let key = "fake-initial-key";
    const config = B.buildLlmConfig(B.normalizeSettings({ providers: { openai: { model: "fake", baseUrl: "https://model.test/v1" } } }), "openai", () => key);
    const r = run(config, c.fetch);
    expect(await r.callLLM({ messages })).not.toBeInstanceOf(Error);
    key = "fake-rotated-key";
    expect(await r.callLLM({ messages })).not.toBeInstanceOf(Error);
    expect(c.requests.map(r => r.headers.get("authorization"))).toEqual(["Bearer fake-initial-key", "Bearer fake-rotated-key"]);
  });
  for (const streaming of [false, true]) test(`three-key rotation redacts historical outbound messages (${streaming ? "stream" : "generate"})`, async () => {
    const c = capture();
    const keys = ["fake-initial-credential", "fake-middle-credential", "fake-current-credential"];
    let key = keys[0]!;
    const reads: string[] = [];
    const secrets = B.runSecrets({ getSecret: id => (reads.push(id), key), setSecret: () => {} }, "openai", "selected-key");
    const config = B.buildLlmConfig(B.normalizeSettings({ providers: { openai: { model: "fake", baseUrl: "https://model.test/v1" } } }), "openai", secrets.apiKey);
    const r = new B.Run({ cannoli: { nodes: [], edges: [] }, llmConfigs: [config], secrets: secrets.resolver, modelFetch: c.fetch });
    for (let i = 0; i < keys.length; i++) {
      key = keys[i]!;
      const turns = [{ role: "user" as const, content: keys.slice(0, i + 1).join(" ") },
        { role: "assistant" as const, content: keys.slice(0, i + 1).join(" ") },
        { role: "user" as const, content: "Continue" }];
      if (streaming) {
        const stream = await r.callLLMStream({ messages: turns });
        if (stream instanceof Error || typeof stream === "string") throw new Error(`Expected stream: ${stream}`);
        for await (const _part of stream) { /* consume completion */ }
      } else expect(await r.callLLM({ messages: turns })).not.toBeInstanceOf(Error);
      expect(c.requests[i]!.headers.get("authorization")).toBe(`Bearer ${key}`);
      const body = JSON.stringify(c.requests[i]!.body);
      for (const known of keys.slice(0, i + 1)) expect(body).not.toContain(known);
    }
    expect([...new Set(reads)]).toEqual(["selected-key"]);
    const count = reads.length;
    expect(secrets.resolver.get("unrelated-storage-id")).toBeNull();
    expect(reads.length).toBe(count);
  });
  for (const providerEngine of ["ai-sdk", "langchain"] as const) test(`${providerEngine} streams use distinct run transports without host egress`, async () => {
    const a = capture(), b = capture();
    const make = (modelFetch: ModelFetch, instance: string) => new B.Run({ cannoli: { nodes: [], edges: [] }, providerEngine,
      llmConfigs: [{ ...azure, azureOpenAIApiInstanceName: instance }], modelFetch });
    const consume = async (r: InstanceType<Bundled["Run"]>) => {
      const stream = await r.callLLMStream({ messages, user: "stream-user" });
      if (stream instanceof Error || typeof stream === "string") throw new Error(`Expected a stream: ${stream}`);
      let text = "";
      for await (const part of stream) text += part;
      expect(text).toBe("ok");
    };
    await Promise.all([consume(make(a.fetch, "first")), consume(make(b.fetch, "second"))]);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(a.requests[0]!.url.hostname).toBe("first.openai.azure.com");
    expect(b.requests[0]!.url.hostname).toBe("second.openai.azure.com");
    expect(a.requests[0]!.body.user).toBe("stream-user");
    expect(b.requests[0]!.body.stream).toBe(true);
  });
  for (const id of ["openai", "azure"]) test(`${id} bare factory fails closed without egress`, async () => {
    const previous = globalThis.fetch;
    const c = capture();
    // The global mock must never be used; no real network is available to this probe.
    globalThis.fetch = c.fetch as typeof globalThis.fetch;
    try {
      const model = B.createProviderModel({ id, kind: "openai", apiKey: "fake", baseURL: "https://blocked.test/v1" }, "deployment");
      if (typeof model === "string") throw new Error("Expected a configured provider model");
      await expect(model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).rejects.toThrow("Host not allowed");
      expect(c.requests).toHaveLength(0);
    } finally { globalThis.fetch = previous; }
  });
});
