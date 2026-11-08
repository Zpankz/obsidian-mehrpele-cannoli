// Keep host transport and legacy request options at the SDK boundary, outside the
// byte-identical core. A missing host installation fails closed.
import { AiSdkModelPort as CorePort, type AiSdkModelPortOptions } from "../../../cannoli-core/src/model/ai-sdk/adapter";
import type { GenerateRequest, GenerateResult, GenericModelConfig, ModelStreamEvent } from "@mehrpele/cannoli-core";
import { fetch as hostFetch } from "../run/fetch-shim";
export * from "../../../cannoli-core/src/model/ai-sdk/adapter";

export class AiSdkModelPort extends CorePort {
  private readonly bridgeOptions: AiSdkModelPortOptions;
  constructor(options: AiSdkModelPortOptions) {
    const scoped = { ...options, fetch: options.fetch ?? hostFetch };
    super(scoped);
    this.bridgeOptions = scoped;
  }

  private prepare(req: GenerateRequest): { port: CorePort; request: GenerateRequest } {
    const legacy = req.providerOptions?.langchain as GenericModelConfig | undefined;
    let request = req;
    if (legacy?.user !== undefined && (legacy.provider === "openai" || legacy.provider === "azure_openai")) {
      request = { ...req, providerOptions: { ...req.providerOptions,
        openai: { user: legacy.user, ...(req.providerOptions?.openai as object | undefined) } } };
    }
    if (legacy?.provider !== "azure_openai") return { port: this, request };

    // The upstream adapter merges generic options only. Azure's deployment is a
    // routing field distinct from the model label, and its instance/version may
    // also change per call. Resolve the complete request before creating a client.
    const deployment = legacy.azureOpenAIApiDeploymentName || legacy.model;
    const baseURL = legacy.baseURL || (legacy.azureOpenAIApiInstanceName
      ? `https://${legacy.azureOpenAIApiInstanceName}.openai.azure.com` : undefined);
    const providers = this.bridgeOptions.providers.map(config => config.id !== "azure" ? config : {
      ...config, ...(baseURL ? { baseURL } : {}),
      ...(legacy.azureOpenAIApiVersion ? { apiVersion: legacy.azureOpenAIApiVersion } : {}),
    });
    request = { ...request, providerOptions: { ...request.providerOptions,
      langchain: { ...legacy, ...(deployment ? { model: deployment } : {}) } } };
    return { port: new CorePort({ ...this.bridgeOptions, providers }), request };
  }

  override generate(req: GenerateRequest): Promise<GenerateResult> {
    const { port, request } = this.prepare(req);
    return port === this ? super.generate(request) : port.generate(request);
  }
  override async *stream(req: GenerateRequest): AsyncGenerator<ModelStreamEvent> {
    const { port, request } = this.prepare(req);
    yield* port === this ? super.stream(request) : port.stream(request);
  }
}
