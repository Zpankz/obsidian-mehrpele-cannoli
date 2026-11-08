// LLM configs for one run, built from settings just before the run starts. The key is resolved
// from SecretStorage here and lives only in this run's config objects (never in data.json).
import { DEFAULT_MODELS, type FlowsSettings, OLLAMA_DEFAULT_URL, type ProviderId } from "../settings/types";

/** The subset of cannoli-core's LLMConfig this companion sets. */
export interface FlowLlmConfig {
  provider: "openai" | "azure_openai" | "ollama" | "gemini" | "anthropic" | "groq";
  apiKey?: string;
  baseURL?: string;
  model?: string;
  azureOpenAIApiDeploymentName?: string;
  azureOpenAIApiVersion?: string;
}

export const AZURE_API_VERSION = "2024-10-21";

/** The core provider a settings provider maps to (openai_compatible -> openai with baseURL). */
export function coreProvider(p: ProviderId): FlowLlmConfig["provider"] {
  return p === "openai_compatible" ? "openai" : p;
}

/**
 * One config for `provider`. `apiKey` is the resolved secret (absent for Ollama or a keyless
 * OpenAI-compatible server).
 */
export function buildLlmConfig(settings: FlowsSettings, provider: ProviderId, apiKey: string | undefined | (() => string | undefined)): FlowLlmConfig {
  const entry = settings.providers[provider] ?? {};
  const model = entry.model ?? DEFAULT_MODELS[provider];
  const config: FlowLlmConfig = { provider: coreProvider(provider), model };
  if (typeof apiKey === "function") Object.defineProperty(config, "apiKey", { enumerable: true, get: () => apiKey() ?? (provider === "openai_compatible" ? "none" : undefined) });
  else if (apiKey) config.apiKey = apiKey;
  else if (provider === "openai_compatible") config.apiKey = "none"; // the OpenAI SDK refuses an empty key
  const baseUrl = entry.baseUrl ?? (provider === "ollama" ? OLLAMA_DEFAULT_URL : undefined);
  if (baseUrl) config.baseURL = baseUrl;
  if (provider === "azure_openai") {
    config.azureOpenAIApiDeploymentName = model;
    config.azureOpenAIApiVersion = AZURE_API_VERSION;
  }
  return config;
}
