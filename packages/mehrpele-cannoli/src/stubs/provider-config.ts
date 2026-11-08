// Browser build bridge for Cannoli's provider config surface. The schema declarations below
// are verbatim from the vendored providers.ts (MIT; full notice in the bundle banner).
// Runtime model calls use AI SDK; this module never imports a legacy provider client.
import { z } from "zod";
import type { GenericModelConfig, LLMConfig } from "@mehrpele/cannoli-core";

export const GenericFunctionCallSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
});

export const GenericModelConfigSchema = z.object({
  provider: z.string().optional(),
  enableVision: z.coerce
    .string()
    .transform((val) => val === "true")
    .optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  function_call: z.object({ name: z.string() }).optional(),
  functions: z.array(GenericFunctionCallSchema).optional(),
  temperature: z.coerce.number().optional(),
  top_p: z.coerce.number().optional(),
  top_k: z.coerce.number().optional(),
  frequency_penalty: z.coerce.number().optional(),
  presence_penalty: z.coerce.number().optional(),
  stop: z.string().optional(),
  role: z.string().optional(),
  microstat: z.boolean().optional(),
  microstat_eta: z.coerce.number().optional(),
  microstat_tau: z.coerce.number().optional(),
  max_tokens: z.coerce.number().optional(),
  user: z.string().optional(),
  num_ctx: z.coerce.number().optional(),
  num_gqa: z.coerce.number().optional(),
  num_gpu: z.coerce.number().optional(),
  num_thread: z.coerce.number().optional(),
  repeat_last_n: z.coerce.number().optional(),
  repeat_penalty: z.coerce.number().optional(),
  seed: z.coerce.number().optional(),
  tfs_z: z.coerce.number().optional(),
  num_predict: z.coerce.number().optional(),
  azureOpenAIApiDeploymentName: z.string().optional(),
  azureOpenAIApiInstanceName: z.string().optional(),
  azureOpenAIApiVersion: z.string().optional(),
});

export class LLMProvider {
  readonly initialized = true;
  readonly configs: LLMConfig[];
  constructor(args: { configs: LLMConfig[] }) {
    this.configs = args.configs;
    if (!this.configs.length) throw new Error("A model provider is required");
  }
  getConfig(): GenericModelConfig { return { ...this.configs[0] }; }
  getDefaultsByProvider(provider: string): GenericModelConfig {
    return Object.fromEntries(Object.entries(this.configs.find(c => c.provider === provider) ?? {}).filter(([, value]) => value !== undefined));
  }
  getMergedConfig(args: { provider?: string; configOverrides?: GenericModelConfig } = {}): GenericModelConfig {
    const provider = args.provider ?? this.configs[0].provider;
    const defaults = this.getDefaultsByProvider(provider);
    if (!defaults.provider) throw new Error(`No provider config found for provider ${provider}`);
    const overrides = Object.fromEntries(Object.entries(args.configOverrides ?? {}).filter(([, v]) => v !== undefined));
    return { ...this.getConfig(), ...defaults, ...overrides, provider };
  }
}
