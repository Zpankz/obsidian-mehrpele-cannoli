// The model registry (DESIGN §4.3): default models, role aliases and
// per-provider API ids.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ROLES,
  MODELS,
  apiIdFor,
  getModelInfo,
  resolveModelAlias,
} from "../../src/model/registry";

describe("model registry", () => {
  it("lists the default table with null prices", () => {
    const refs = MODELS.map((m) => m.ref);
    expect(refs).toEqual(
      expect.arrayContaining([
        "anthropic:claude-sonnet-5-5",
        "anthropic:claude-opus-5-5",
        "anthropic:claude-haiku-5-5",
        "anthropic:claude-fable-5-1",
        "openai:gpt-6-astra",
        "openai:gpt-6.1-sol",
        "openai:gpt-6-luna",
        "google:gemini-4-argon",
        "google:gemini-3.8-flash",
        "ollama:qwen3.5:4b",
      ]),
    );
    for (const m of MODELS) expect(m.price).toBeNull();
    expect(getModelInfo("anthropic:claude-opus-5-5")?.roles).toContain("agent");
    expect(getModelInfo("openai:nope")).toBeUndefined();
  });

  it("alias resolution call/agent/router/local", () => {
    expect(resolveModelAlias("call")).toBe("anthropic:claude-sonnet-5-5");
    expect(resolveModelAlias("agent")).toBe("anthropic:claude-opus-5-5");
    expect(resolveModelAlias("router")).toBe("anthropic:claude-haiku-5-5");
    expect(resolveModelAlias("orchestrator")).toBe(
      "anthropic:claude-fable-5-1",
    );
    expect(resolveModelAlias("local")).toBe("ollama:qwen3.5:4b");

    const roles = {
      ...DEFAULT_MODEL_ROLES,
      call: "openai:gpt-6-astra",
      local: undefined,
    } as const;
    expect(resolveModelAlias("call", roles)).toBe("openai:gpt-6-astra");
    // An unset optional role falls back to the default.
    expect(resolveModelAlias("local", roles)).toBe("ollama:qwen3.5:4b");
    // A full ref passes through; a bare registry id finds its ref.
    expect(resolveModelAlias("google:gemini-4-argon")).toBe(
      "google:gemini-4-argon",
    );
    expect(resolveModelAlias("gpt-6-luna")).toBe("openai:gpt-6-luna");
    expect(() => resolveModelAlias("no-such-model")).toThrow(/no-such-model/);
  });

  it("openrouter apiId uses dotted ids", () => {
    expect(apiIdFor("anthropic:claude-opus-5-5", "openrouter")).toBe(
      "anthropic/claude-opus-5.5",
    );
    expect(apiIdFor("anthropic:claude-fable-5-1", "openrouter")).toBe(
      "anthropic/claude-fable-5.1",
    );
    expect(apiIdFor("anthropic:claude-opus-5-5", "anthropic")).toBe(
      "claude-opus-5-5",
    );
    // An unknown model keeps its model part.
    expect(apiIdFor("ollama:llama3:8b", "openrouter")).toBe("llama3:8b");
  });
});
