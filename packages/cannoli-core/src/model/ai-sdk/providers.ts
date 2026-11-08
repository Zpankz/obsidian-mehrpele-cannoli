import type { ModelFetch } from "../fetch";
// AI SDK provider factories (DESIGN §4.4, P1.3). Every factory gets the
// host's fetch, so the plugin can route calls through Obsidian.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { LLMConfig } from "../../providers";
import type { ProviderId } from "../types";

export interface AiSdkProviderConfig {
  /** What requests name the provider by: the ref prefix, or a legacy provider id. */
  id: string;
  kind: ProviderId;
  /** Model used when a legacy call omits its model. */
  defaultModel?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

const OLLAMA_BASE_URL = "http://localhost:11434";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** Ollama serves the OpenAI API under /v1; accept the base with or without it. */
function ollamaBaseURL(baseURL = OLLAMA_BASE_URL): string {
  return `${baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

/** LangChain's anthropicApiUrl omits /v1; the AI SDK's baseURL includes it. */
function anthropicBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The AI SDK model for `modelId` on the configured provider. */
export function createProviderModel(
  config: AiSdkProviderConfig,
  modelId: string,
  fetch?: ModelFetch,
): LanguageModel {
  const { apiKey, headers } = config;
  let baseURL = config.baseURL || undefined;
  // Provider packages append endpoint paths to baseURL as a string. Keep the
  // query at the transport boundary so it follows the completed endpoint path.
  if (baseURL) {
    const url = new URL(baseURL);
    const query = new URLSearchParams(url.search);
    url.search = "";
    url.hash = "";
    baseURL = url.href.replace(/\/+$/, "");
    if (query.size) {
      const transport = fetch ?? globalThis.fetch;
      fetch = (input, init) => {
        const target = new URL(input instanceof Request ? input.url : input);
        query.forEach((value, key) => target.searchParams.append(key, value));
        return transport(
          input instanceof Request ? new Request(target, input) : target.href,
          init,
        );
      };
    }
  }
  // SDK declarations refer to the global fetch type. Some runtimes augment it
  // with static helpers; provider factories only call the transport itself.
  const sdkFetch = fetch as typeof globalThis.fetch | undefined;
  switch (config.kind) {
    case "anthropic":
      return createAnthropic({
        apiKey,
        baseURL: baseURL && anthropicBaseURL(baseURL),
        // Anthropic refuses browser-origin calls without this.
        headers: {
          ...headers,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        fetch: sdkFetch,
      })(modelId);
    case "openai": {
      const openai = createOpenAI({
        apiKey,
        baseURL,
        headers,
        fetch: sdkFetch,
      });
      // Chat preserves the legacy stop, seed and penalty controls.
      return openai.chat(modelId);
    }
    case "google":
      return createGoogle({ apiKey, baseURL, headers, fetch: sdkFetch })(
        modelId,
      );
    case "openrouter":
      return createOpenRouter({ apiKey, baseURL, headers, fetch: sdkFetch })(
        modelId,
      );
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaBaseURL(baseURL),
        apiKey,
        headers,
        includeUsage: true,
        fetch: sdkFetch,
      })(modelId);
    case "openai-compatible":
      if (!baseURL) {
        throw new Error(
          `Provider "${config.id}" needs a base URL for an OpenAI-compatible endpoint.`,
        );
      }
      return createOpenAICompatible({
        name: config.id,
        baseURL,
        apiKey,
        headers,
        includeUsage: true,
        fetch: sdkFetch,
      })(modelId);
  }
}

/** Legacy provider names to the config id requests resolve them by. */
export const LEGACY_PROVIDER_IDS: Record<string, string | undefined> = {
  openai: "openai",
  gemini: "google",
  anthropic: "anthropic",
  ollama: "ollama",
  groq: "groq",
  // No AI SDK provider here: azure_openai runs on the fallback port.
  azure_openai: undefined,
};

/**
 * The v3 settings' LLMConfigs as AI SDK providers. azure_openai is left out,
 * so its calls go to the fallback (LangChain) port.
 */
export function providersFromLegacyConfigs(
  llmConfigs: LLMConfig[],
): AiSdkProviderConfig[] {
  const providers: AiSdkProviderConfig[] = [];
  for (const config of llmConfigs) {
    const id = LEGACY_PROVIDER_IDS[config.provider];
    if (!id) continue;
    const provider: AiSdkProviderConfig =
      config.provider === "groq"
        ? { id, kind: "openai-compatible" }
        : { id, kind: id as ProviderId };
    if (config.model) provider.defaultModel = config.model;
    if (config.apiKey) provider.apiKey = config.apiKey;
    if (config.provider === "groq") provider.baseURL = GROQ_BASE_URL;
    // Legacy gemini ignores baseURL; keep that.
    else if (config.baseURL && config.provider !== "gemini") {
      provider.baseURL = config.baseURL;
    }
    providers.push(provider);
  }
  return providers;
}
