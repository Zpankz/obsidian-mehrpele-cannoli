                                                                                             
// deliberately no apiKey field anywhere in this file (test/store-lint.test.ts checks that).

export const PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "groq",
  "azure_openai",
  "ollama",
  "openai_compatible",
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderSettings {
  /** SecretStorage id picked by the user. Ollama needs none. */
  secretId?: string;
  baseUrl?: string;
  model?: string;
}

export interface NetworkSettings {
  /** Host globs HTTP nodes may reach, e.g. "api.example.com" or "*.example.org". */
  allow: string[];
  /** Ask before the first request to each allowed host. */
  askFirstHost: boolean;
  allowLocalhost: boolean;
  /** Hosts the user has approved after the first-request prompt. */
  approvedHosts: string[];
}

export interface FlowsSettings {
  providers: { [p in ProviderId]?: ProviderSettings };
  defaultProvider: ProviderId | null;
  network: NetworkSettings;
  runs: { keep: number };
  /** Flow path -> hash of the reference set the user confirmed. */
  confirmed: Record<string, string>;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  groq: "Groq",
  azure_openai: "Azure OpenAI",
  ollama: "Ollama",
  openai_compatible: "OpenAI-compatible",
};

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  azure_openai: "gpt-4o-mini",
  ollama: "llama3.2",
  openai_compatible: "gpt-4o-mini",
};

/** Fixed API hosts. The others take their host from the user's base URL. */
export const DEFAULT_HOSTS: Partial<Record<ProviderId, string>> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  gemini: "generativelanguage.googleapis.com",
  groq: "api.groq.com",
};

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const DEFAULT_KEEP = 50;

export function defaultSettings(): FlowsSettings {
  return {
    providers: {},
    defaultProvider: null,
    network: { allow: [], askFirstHost: true, allowLocalhost: true, approvedHosts: [] },
    runs: { keep: DEFAULT_KEEP },
    confirmed: {},
  };
}

export const isProvider = (p: unknown): p is ProviderId => PROVIDERS.includes(p as ProviderId);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))] : [];

/** Parses whatever loadData returned into the schema, dropping every unknown field. */
export function normalizeSettings(raw: unknown): FlowsSettings {
  const s = defaultSettings();
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  const providers = (r.providers ?? {}) as Record<string, unknown>;
  for (const p of PROVIDERS) {
    const v = providers[p] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object") continue;
    const entry: ProviderSettings = {};
    const secretId = str(v.secretId);
    const baseUrl = str(v.baseUrl);
    const model = str(v.model);
    if (secretId) entry.secretId = secretId;
    if (baseUrl) entry.baseUrl = baseUrl;
    if (model) entry.model = model;
    s.providers[p] = entry;
  }
  if (isProvider(r.defaultProvider)) s.defaultProvider = r.defaultProvider;
  const n = (r.network ?? {}) as Record<string, unknown>;
  s.network = {
    allow: strList(n.allow),
    askFirstHost: typeof n.askFirstHost === "boolean" ? n.askFirstHost : true,
    allowLocalhost: typeof n.allowLocalhost === "boolean" ? n.allowLocalhost : true,
    approvedHosts: strList(n.approvedHosts).map((h) => h.toLowerCase()),
  };
  const keep = Number((r.runs as Record<string, unknown> | undefined)?.keep);
  s.runs.keep = Number.isFinite(keep) && keep >= 1 ? Math.min(Math.floor(keep), 1000) : DEFAULT_KEEP;
  const confirmed = (r.confirmed ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(confirmed)) if (typeof v === "string") s.confirmed[k] = v;
  return s;
}

/** Ollama needs nothing; Azure and OpenAI-compatible need a URL; the rest need a key. */
export function isConfigured(settings: FlowsSettings, p: ProviderId): boolean {
  const v = settings.providers[p];
  if (!v) return false;
  switch (p) {
    case "ollama":
      return true;
    case "openai_compatible":
      return !!v.baseUrl;
    case "azure_openai":
      return !!v.baseUrl && !!v.secretId;
    default:
      return !!v.secretId;
  }
}

export function configuredProviders(settings: FlowsSettings): ProviderId[] {
  return PROVIDERS.filter((p) => isConfigured(settings, p));
}

/** The default provider if it is configured, else the first configured one, else null. */
export function effectiveProvider(settings: FlowsSettings): ProviderId | null {
  if (settings.defaultProvider && isConfigured(settings, settings.defaultProvider)) return settings.defaultProvider;
  return configuredProviders(settings)[0] ?? null;
}

/** `host` of a URL (hostname plus any non-default port), lowercased. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host (with port, if any) a provider's requests go to, or null if it has no usable URL. */
export function providerHost(settings: FlowsSettings, p: ProviderId): string | null {
  const v = settings.providers[p];
  if (v?.baseUrl) return hostOf(v.baseUrl);
  if (p === "ollama") return hostOf(OLLAMA_DEFAULT_URL);
  return DEFAULT_HOSTS[p] ?? null;
}
