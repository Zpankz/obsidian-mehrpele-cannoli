// Keep upstream SDK factories and add the companion's existing Azure settings surface.
// This bridge is outside the byte-identical vendored tree.
import {
  createProviderModel as upstreamModel,
  providersFromLegacyConfigs as upstreamConfigs,
  LEGACY_PROVIDER_IDS,
  type AiSdkProviderConfig,
} from "../../../cannoli-core/src/model/ai-sdk/providers";
import { fetch as hostFetch } from "../run/fetch-shim";
import type { LLMConfig, ModelFetch } from "@mehrpele/cannoli-core";

// The upstream adapter resolves legacy requests through this shared routing table.
LEGACY_PROVIDER_IDS.azure_openai = "azure";
export { LEGACY_PROVIDER_IDS };

interface AzureConfig extends AiSdkProviderConfig {
  apiVersion?: string;
}

export function providersFromLegacyConfigs(configs: LLMConfig[]): AzureConfig[] {
  return configs.flatMap((config) => {
    if (config.provider !== "azure_openai") return upstreamConfigs([config]);
    return [{
      id: "azure", kind: "openai", defaultModel: config.azureOpenAIApiDeploymentName || config.model,
      apiKey: config.apiKey,
      baseURL: config.baseURL || (config.azureOpenAIApiInstanceName ? `https://${config.azureOpenAIApiInstanceName}.openai.azure.com` : undefined),
      apiVersion: config.azureOpenAIApiVersion,
    } satisfies AzureConfig];
  });
}

export function createProviderModel(config: AzureConfig, modelId: string, fetch: ModelFetch = hostFetch) {
  if (config.id !== "azure") return upstreamModel(config, modelId, fetch);
  if (!config.baseURL) throw new Error("Azure OpenAI needs a base URL");
  const endpoint = new URL(config.baseURL);
  endpoint.hash = "";
  // Accept the resource URL and existing deployment URLs without doubling the path.
  endpoint.pathname = `${endpoint.pathname.replace(/\/openai(?:\/.*)?$/, "").replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(modelId)}`;
  // An explicitly configured URL query keeps the legacy defaultQuery precedence.
  if (!endpoint.searchParams.has("api-version")) endpoint.searchParams.set("api-version", config.apiVersion || "2024-10-21");
  const transport = fetch;
  return upstreamModel({ ...config, kind: "openai", baseURL: endpoint.href }, modelId, (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.delete("authorization");
    if (config.apiKey) headers.set("api-key", config.apiKey);
    return transport(input, { ...init, headers });
  });
}
