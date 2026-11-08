// Chat-only browser factory using the pinned SDK's original chat implementation.
// Adapted from Vercel AI SDK openai-provider.ts (Apache-2.0): other API factories omitted.
import { loadApiKey, withUserAgentSuffix } from "@ai-sdk/provider-utils";
import { OpenAIChatLanguageModel } from "pele-openai-chat";
import { VERSION } from "pele-openai-version";
export function createOpenAI(options = {}) {
  const baseURL = (options.baseURL || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const url = new URL(baseURL);
  if (!/^https?:$/.test(url.protocol))
    throw new Error("OpenAI requires an HTTP endpoint");
  if (typeof options.fetch !== "function")
    throw new Error("OpenAI needs the workflow model transport");
  return {
    chat: (modelId) =>
      new OpenAIChatLanguageModel(modelId, {
        provider: `${options.name ?? "openai"}.chat`,
        url: ({ path }) => `${baseURL}${path}`,
        headers: () =>
          withUserAgentSuffix(
            {
              Authorization: `Bearer ${loadApiKey({ apiKey: options.apiKey, environmentVariableName: "OPENAI_API_KEY", description: "OpenAI" })}`,
              ...options.headers,
            },
            `ai-sdk-openai/${VERSION}`,
          ),
        fetch: options.fetch,
      }),
  };
}
