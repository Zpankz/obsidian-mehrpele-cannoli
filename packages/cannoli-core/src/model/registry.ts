// The model registry (DESIGN §4.3): the default models, their per-provider
// API ids, and the role aliases canvases use (`model: call|agent|...`).
// Prices stay null until P2.3 fills them from the providers' pricing pages.
import models from "./models.json";
import type { ModelRef, ProviderId } from "./types";

export type ModelRole = "call" | "agent" | "router" | "orchestrator" | "local";

export interface ModelInfo {
  ref: ModelRef;
  /** The id each provider serves this model under; OpenRouter uses dotted ids. */
  apiId: Partial<Record<ProviderId, string>>;
  label: string;
  roles: ModelRole[];
  contextWindow: number | null;
  maxOutput: number | null;
  supports: {
    tools: boolean;
    vision: boolean;
    structured: "native" | "tool" | "none";
    reasoning: boolean;
    cache: "explicit" | "automatic" | "none";
  };
  price: {
    inUsdPerMTok: number;
    outUsdPerMTok: number;
    cacheReadUsdPerMTok?: number;
    cacheWriteUsdPerMTok?: number;
    asOf: string;
  } | null;
}

/** The model each role alias resolves to. */
export interface ModelRoles {
  call: ModelRef;
  agent: ModelRef;
  router: ModelRef;
  orchestrator?: ModelRef;
  local?: ModelRef;
}

export const MODELS: readonly ModelInfo[] = models as ModelInfo[];

/** The defaults for new installs (DESIGN §4.3). */
export const DEFAULT_MODEL_ROLES: Required<ModelRoles> = {
  call: "anthropic:claude-sonnet-5-5",
  agent: "anthropic:claude-opus-5-5",
  router: "anthropic:claude-haiku-5-5",
  orchestrator: "anthropic:claude-fable-5-1",
  local: "ollama:qwen3.5:4b",
};

const PROVIDERS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
  "openai-compatible",
]);

function isRole(name: string): name is ModelRole {
  return name in DEFAULT_MODEL_ROLES;
}

/** The model part of a ref: everything after the first ":". */
function modelPart(ref: string): string {
  return ref.slice(ref.indexOf(":") + 1);
}

export function getModelInfo(ref: string): ModelInfo | undefined {
  return MODELS.find((m) => m.ref === ref);
}

/**
 * A role alias, a `provider:model` ref or a bare registry model id to a
 * ModelRef. Unset optional roles fall back to the defaults. Legacy
 * `provider` + `model` config maps through `toModelRef` instead.
 */
export function resolveModelAlias(
  refOrAlias: string,
  roles: ModelRoles = DEFAULT_MODEL_ROLES,
): ModelRef {
  if (isRole(refOrAlias)) {
    return roles[refOrAlias] ?? DEFAULT_MODEL_ROLES[refOrAlias];
  }
  const separator = refOrAlias.indexOf(":");
  if (separator > 0 && PROVIDERS.has(refOrAlias.slice(0, separator))) {
    return refOrAlias as ModelRef;
  }
  const info = MODELS.find((m) => modelPart(m.ref) === refOrAlias);
  if (info) return info.ref;
  throw new Error(`Unknown model or alias "${refOrAlias}".`);
}

/** The id to send `provider` for `ref`; unknown models keep their model part. */
export function apiIdFor(ref: string, provider: ProviderId): string {
  return getModelInfo(ref)?.apiId[provider] ?? modelPart(ref);
}
