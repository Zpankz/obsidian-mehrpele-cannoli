/**
 * Host seam for secrets (API keys, tokens). The host (the Obsidian plugin, a
 * baked function, a server) resolves values; core only ever asks by NAME, the
 * name a canvas uses (e.g. `OPENAI_API_KEY`, `MY_TOKEN`), never by storage id.
 *
 * Resolved values are for provider auth and HTTP templates only. They are never
 * exposed to LLM-visible text, and the run redacts them before persisting.
 */
export interface SecretResolver {
  /** The secret's value, or null when it is not set. */
  get(name: string): string | null;
  /** Every secret name this resolver can answer for. */
  names(): string[];
}

export const emptySecretResolver: SecretResolver = {
  get: () => null,
  names: () => [],
};

/** A resolver over a plain `{ NAME: value }` record (tests, bake, sub-cannolis). */
export function secretResolverFromRecord(
  rec: Record<string, string>,
): SecretResolver {
  const copy = { ...rec };
  return {
    get: (name) =>
      Object.prototype.hasOwnProperty.call(copy, name) ? copy[name] : null,
    names: () => Object.keys(copy),
  };
}

/** `{ NAME: value }` for every name that resolves to a value. */
export function secretsToRecord(
  secrets: SecretResolver,
): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const name of secrets.names()) {
    const value = secrets.get(name);
    if (value !== null) rec[name] = value;
  }
  return rec;
}

/**
 * Accept a resolver, or a plain record from callers built against the old
 * `secrets: Record<string, string>` shape (e.g. previously baked code).
 */
export function toSecretResolver(
  secrets: SecretResolver | Record<string, string> | null | undefined,
): SecretResolver {
  if (!secrets) return emptySecretResolver;
  if (
    typeof (secrets as SecretResolver).get === "function" &&
    typeof (secrets as SecretResolver).names === "function"
  ) {
    return secrets as SecretResolver;
  }
  return secretResolverFromRecord(secrets as Record<string, string>);
}

const hasOwn = (rec: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(rec, key);

/**
 * `secrets` plus every non-empty provider API key from `llmConfigs`, named
 * `provider-key-<provider>` (with `-2`, `-3`... for repeats), so redaction
 * covers keys that never went through the resolver.
 */
export function withProviderKeys(
  secrets: SecretResolver,
  llmConfigs: { provider: string; apiKey?: string }[],
): SecretResolver {
  const keys: Record<string, string> = {};
  for (const { provider, apiKey } of llmConfigs) {
    if (!apiKey || apiKey.trim() === "") continue;
    if (Object.values(keys).includes(apiKey)) continue;
    let name = `provider-key-${provider}`;
    for (let n = 2; hasOwn(keys, name) || secrets.names().includes(name); n++) {
      name = `provider-key-${provider}-${n}`;
    }
    keys[name] = apiKey;
  }
  if (Object.keys(keys).length === 0) return secrets;
  return {
    get: (name) =>
      secrets.get(name) ?? (hasOwn(keys, name) ? keys[name] : null),
    names: () => [...new Set([...secrets.names(), ...Object.keys(keys)])],
  };
}
