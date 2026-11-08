                                                                                                   
// file, and leaves no key value in our settings.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cannoliDataExists, cannoliDataPath, IMPORT_BANNER, IMPORT_DONE, importCannoliKeys } from "../src/settings/import-cannoli";
import { SettingsStore } from "../src/settings/store";
import { defaultSettings } from "../src/settings/types";
import { fakeApp, fakeSettingsHost } from "./support/fake-app";

const SRC = ".obsidian/plugins/cannoli/data.json";
const CANNOLI = JSON.stringify({
  openaiAPIKey: "fake-key-for-tests-aaaa",
  anthropicAPIKey: " fake-key-for-tests-bbbb ",
  geminiAPIKey: "",
  groqAPIKey: null,
  openaiBaseURL: "https://proxy.example.org/v1",
  ollamaBaseUrl: "http://localhost:11434/",
  defaultLLMProvider: "openai",
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("import from Cannoli", () => {
  test("copies non-empty keys to SecretStorage and stores only their ids", async () => {
    const fake = fakeApp({ [SRC]: CANNOLI });
    const before = sha(fake.files.get(SRC)!);
    const s = defaultSettings();
    const result = await importCannoliKeys(fake.app, s);

    expect(result).toEqual({ imported: ["openai", "anthropic"], baseUrls: ["openai"] });
    expect(fake.secretCalls).toEqual(["set mehrpele-flows-key-openai", "set mehrpele-flows-key-anthropic"]);
    expect(fake.secrets.get("mehrpele-flows-key-openai")).toBe("fake-key-for-tests-aaaa");
    expect(fake.secrets.get("mehrpele-flows-key-anthropic")).toBe("fake-key-for-tests-bbbb");
    expect(s.providers).toEqual({
      openai: { secretId: "mehrpele-flows-key-openai", baseUrl: "https://proxy.example.org/v1" },
      anthropic: { secretId: "mehrpele-flows-key-anthropic" },
    });
    expect(s.defaultProvider).toBe("openai");

    // Cannoli's file: read once through the adapter, never written, byte-identical.
    expect(sha(fake.files.get(SRC)!)).toBe(before);
    expect(fake.calls).toEqual([`adapter.read ${SRC}`]);
  });

  test("saved settings contain no key value", async () => {
    const fake = fakeApp({ [SRC]: CANNOLI });
    const host = fakeSettingsHost(null);
    const store = new SettingsStore(host);
    const s = await store.get();
    await importCannoliKeys(fake.app, s);
    await store.update(() => undefined);
    expect(host.json).not.toContain("fake-key-for-tests");
    expect(JSON.parse(host.json!).providers.openai.secretId).toBe("mehrpele-flows-key-openai");
  });

  test("keeps a base URL the user already set and an existing default provider", async () => {
    const fake = fakeApp({ [SRC]: CANNOLI });
    const s = defaultSettings();
    s.providers.openai = { baseUrl: "https://mine.example.org/v1" };
    s.defaultProvider = "groq";
    const r = await importCannoliKeys(fake.app, s);
    expect(r.baseUrls).toEqual([]);
    expect(s.providers.openai).toEqual({ baseUrl: "https://mine.example.org/v1", secretId: "mehrpele-flows-key-openai" });
    expect(s.defaultProvider).toBe("groq");
  });

  test("a non-default Ollama URL is carried", async () => {
    const fake = fakeApp({ [SRC]: JSON.stringify({ ollamaBaseUrl: "http://10.0.0.5:11434" }) });
    const s = defaultSettings();
    expect((await importCannoliKeys(fake.app, s)).baseUrls).toEqual(["ollama"]);
    expect(s.providers.ollama).toEqual({ baseUrl: "http://10.0.0.5:11434" });
    expect(s.defaultProvider).toBeNull();
  });

  test("texts, detection and failures", async () => {
    expect(IMPORT_DONE).toBe(
      "Keys copied. Cannoli still stores its own copy in plain text; remove it there if you no longer use Cannoli.",
    );
    expect(IMPORT_BANNER).toBe("Cannoli detected: import its provider keys into secure storage?");
    expect(cannoliDataPath(".obsidian")).toBe(SRC);
    expect(await cannoliDataExists(fakeApp({ [SRC]: "{}" }).app)).toBe(true);
    expect(await cannoliDataExists(fakeApp().app)).toBe(false);

    const noStorage = { ...fakeApp({ [SRC]: CANNOLI }).app, secretStorage: undefined };
    await expect(importCannoliKeys(noStorage, defaultSettings())).rejects.toThrow("Obsidian 1.11.4");
    await expect(importCannoliKeys(fakeApp({ [SRC]: "{not json" }).app, defaultSettings())).rejects.toThrow("not valid JSON");
  });
});
