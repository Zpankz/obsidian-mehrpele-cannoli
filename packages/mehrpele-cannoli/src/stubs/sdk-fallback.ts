// The browser companion serves every supported model through AI SDK, including Azure.
// Retain the core's fallback interface without importing legacy provider clients.
import { AiSdkModelPort, type GenerateRequest, type GenerateResult, type ModelStreamEvent, type ModelFetch } from "@mehrpele/cannoli-core";
import type { LLMProvider } from "./provider-config";
import { providersFromLegacyConfigs } from "./sdk-providers";

export class LangchainModelPort {
  private readonly port: AiSdkModelPort;
  constructor(readonly llm: LLMProvider, modelFetch?: ModelFetch) {
    this.port = new AiSdkModelPort({ providers: providersFromLegacyConfigs(llm.configs), fetch: modelFetch });
  }
  generate(req: GenerateRequest): Promise<GenerateResult> { return this.port.generate(req); }
  stream(req: GenerateRequest): AsyncIterable<ModelStreamEvent> { return this.port.stream(req); }
  async goal(): Promise<GenerateResult> {
    // Goal nodes require the Cannoli server/MCP bridge, already unavailable in this companion.
    throw new Error("Goal agents require a server integration unavailable in Mehrpele Flows");
  }
}
