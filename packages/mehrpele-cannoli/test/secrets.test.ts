                                                                                               
import { describe, expect, test } from "bun:test";
import { AZURE_API_VERSION, buildLlmConfig, coreProvider } from "../src/run/llm-configs";
import { NO_PROVIDER_NOTICE, runCanvas } from "../src/run/runner";
import { isValidSecretId, resolveSecret, suggestSecretId } from "../src/settings/secrets";
import { SettingsStore } from "../src/settings/store";
import { effectiveProvider, normalizeSettings, providerHost } from "../src/settings/types";
import { fakeApp, fakeSettingsHost, fileOf } from "./support/fake-app";
import { FAKE_KEY, fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

describe("secret ids", () => {
  test("suggested ids are valid SecretStorage ids", () => {
    expect(suggestSecretId("openai")).toBe("mehrpele-flows-key-openai");
    expect(suggestSecretId("azure_openai")).toBe("mehrpele-flows-key-azure-openai");
    expect(suggestSecretId("openai_compatible")).toBe("mehrpele-flows-key-openai-compatible");
    expect(isValidSecretId("mehrpele-flows-key-azure-openai")).toBe(true);
    for (const bad of ["", "Upper", "under_score", "-lead", "trail-", "a--b", "sp ace"]) expect(isValidSecretId(bad)).toBe(false);
  });

  test("resolveSecret reads only the picked id", () => {
    const fake = fakeApp();
    fake.secrets.set("picked", FAKE_KEY);
    fake.secrets.set("other", "fake-key-for-tests-bbbb");
    expect(resolveSecret(fake.app.secretStorage, "picked")).toEqual({ id: "picked", value: FAKE_KEY });
    expect(resolveSecret(fake.app.secretStorage, "missing")).toBeNull();
    expect(resolveSecret(fake.app.secretStorage, "Bad Id")).toBeNull();
    expect(resolveSecret(fake.app.secretStorage, undefined)).toBeNull();
    expect(resolveSecret(undefined, "picked")).toBeNull();
    expect(fake.secretCalls).toEqual(["get picked", "get missing"]);
  });
});

describe("settings never hold a key", () => {
  const raw = {
    apiKey: FAKE_KEY,
    providers: { openai: { secretId: "k", apiKey: FAKE_KEY, model: " gpt-4o " }, bogus: { secretId: "x" } },
    defaultProvider: "openai",
    network: { allow: ["a.example.org", "a.example.org", 3], approvedHosts: ["A.Example.org"] },
    runs: { keep: 5000 },
    confirmed: { "f.canvas": "h", bad: 1 },
  };

  test("normalizeSettings drops unknown fields, apiKey included", () => {
    const s = normalizeSettings(raw);
    expect(s).toEqual({
      providers: { openai: { secretId: "k", model: "gpt-4o" } },
      defaultProvider: "openai",
      network: { allow: ["a.example.org"], askFirstHost: true, allowLocalhost: true, approvedHosts: ["a.example.org"] },
      runs: { keep: 1000 },
      confirmed: { "f.canvas": "h" },
    });
    expect(JSON.stringify(s)).not.toContain(FAKE_KEY);
    expect(normalizeSettings(null).runs.keep).toBe(50);
  });

  test("the store re-normalises on save, so a key set by mistake never reaches data.json", async () => {
    const host = fakeSettingsHost(raw);
    const store = new SettingsStore(host);
    await store.update((s) => {
      (s.providers.openai as Record<string, unknown>).apiKey = FAKE_KEY;
    });
    expect(host.json).not.toContain(FAKE_KEY);
    expect(host.json).not.toContain("apiKey");
    expect(host.saves).toBe(1);
  });

  test("the store loads once and only when asked", async () => {
    let loads = 0;
    const store = new SettingsStore({ loadData: async () => (loads++, null), saveData: async () => {} });
    expect(store.current).toBeNull();
    expect(loads).toBe(0);
    await Promise.all([store.get(), store.get()]);
    expect(loads).toBe(1);
  });
});

describe("llm configs", () => {
  const s = normalizeSettings({
    providers: {
      openai: { secretId: "k" },
      openai_compatible: { baseUrl: "http://127.0.0.1:1234/v1", model: "local" },
      azure_openai: { secretId: "a", baseUrl: "https://res.openai.azure.com", model: "dep" },
      ollama: {},
      anthropic: { secretId: "c", model: "claude-x" },
    },
  });

  test("openai_compatible maps to the core openai provider with baseURL", () => {
    expect(coreProvider("openai_compatible")).toBe("openai");
    expect(buildLlmConfig(s, "openai_compatible", FAKE_KEY)).toEqual({
      provider: "openai",
      model: "local",
      apiKey: FAKE_KEY,
      baseURL: "http://127.0.0.1:1234/v1",
    });
    expect(buildLlmConfig(s, "openai_compatible", undefined).apiKey).toBe("none");
    expect(providerHost(s, "openai_compatible")).toBe("127.0.0.1:1234");
  });

  test("openai, azure, ollama and anthropic", () => {
    expect(buildLlmConfig(s, "openai", FAKE_KEY)).toEqual({ provider: "openai", model: "gpt-4o-mini", apiKey: FAKE_KEY });
    expect(buildLlmConfig(s, "azure_openai", FAKE_KEY)).toEqual({
      provider: "azure_openai",
      model: "dep",
      apiKey: FAKE_KEY,
      baseURL: "https://res.openai.azure.com",
      azureOpenAIApiDeploymentName: "dep",
      azureOpenAIApiVersion: AZURE_API_VERSION,
    });
    expect(buildLlmConfig(s, "ollama", undefined)).toEqual({ provider: "ollama", model: "llama3.2", baseURL: "http://localhost:11434" });
    expect(buildLlmConfig(s, "anthropic", FAKE_KEY)).toEqual({ provider: "anthropic", model: "claude-x", apiKey: FAKE_KEY });
    expect(providerHost(s, "ollama")).toBe("localhost:11434");
  });

  test("effective provider: the default if configured, else the first configured", () => {
    expect(effectiveProvider(normalizeSettings({ providers: { openai: {} } }))).toBeNull();
    expect(effectiveProvider(normalizeSettings({ providers: { groq: { secretId: "g" } }, defaultProvider: "openai" }))).toBe("groq");
    expect(effectiveProvider(normalizeSettings({ providers: { azure_openai: { secretId: "a" } } }))).toBeNull();
  });
});

describe("runner and secrets", () => {
  const FLOW = "Flows/Hello world.canvas";

  test("a missing key refuses the run and reads only the picked id", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    fake.secrets.set("some-other-key", "fake-key-for-tests-bbbb");
    const h = runnerHarness(fake, openaiSettings());
    const out = await runCanvas(h.deps, fileOf(FLOW));
    expect(out.status).toBe("refused");
    expect(out.reason).toContain('"mehrpele-flows-key-openai" is not in secure storage');
    expect(fake.secretCalls).toEqual(["get mehrpele-flows-key-openai"]);
    expect(h.registry.size).toBe(0);
  });

  test("a mock run never reads a secret", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, openaiSettings());
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(out.status).toBe("complete");
    expect(fake.secretCalls).toEqual([]);
  });

  test("model node without a provider: probe then refuse before execution", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, { providers: { openai: {} } });
    const out = await runCanvas(h.deps, fileOf(FLOW));
    expect(out).toMatchObject({ status: "refused", reason: NO_PROVIDER_NOTICE });
    expect(NO_PROVIDER_NOTICE).toBe("Add a model provider in Mehrpele Flows settings before running a flow.");
    expect(h.notices).toEqual([NO_PROVIDER_NOTICE]);
    expect(h.engineLoads).toBe(1);
    expect(records(fake)[0]).toMatchObject({ status: "refused", provider: null });
  });
});
