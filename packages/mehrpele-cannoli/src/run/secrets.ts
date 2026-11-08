// Only the selected provider's current and cached historical values resolve.
// Storage ids never enter core, and history aliases never read secure storage.
import type { SecretResolver } from "../flows/engine";
import { resolveSecret, type SecretStorageLike } from "../settings/secrets";
import type { ProviderId } from "../settings/types";
import { addConsoleSecret } from "./console-shim";
import { createRedactor, type Redactor, type SecretValue } from "./redact";

const NAMES: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY", openai_compatible: "OPENAI_API_KEY", azure_openai: "AZURE_OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY", gemini: "GOOGLE_API_KEY", groq: "GROQ_API_KEY", ollama: "OLLAMA_API_KEY",
};

export function runSecrets(storage: SecretStorageLike | undefined, provider: ProviderId, id: string | undefined) {
  const name = NAMES[provider];
  const seen: SecretValue[] = [];
  const history = new Map<string, string>();
  let current = createRedactor(seen);
  // Consumers retain these forwarding functions while storage values rotate.
  const redactor: Redactor = { text: text => current.text(text), deep: value => current.deep(value) };
  const resolver: SecretResolver = {
    // Core enumerates this resolver for outbound text redaction. Cached logical
    // aliases retain every resolved version; they never trigger storage lookups.
    names: () => id ? [name, ...history.keys()] : [],
    get: requested => {
      if (history.has(requested)) return history.get(requested)!;
      if (!id || requested !== name) return null;
      const secret = resolveSecret(storage, id);
      if (!secret) return null;
      if (!seen.some(s => s.value === secret.value)) {
        seen.push(secret);
        history.set(`${name}__RESOLVED_${seen.length}`, secret.value);
        current = createRedactor(seen);
        addConsoleSecret(secret);
      }
      return secret.value;
    },
  };
  return { resolver, redactor, name,
    apiKey: (): string | undefined => {
      const value = resolver.get(name);
      if (id && !value) throw new Error(`Provider key "${id}" is not in secure storage`);
      return value ?? undefined;
    },
  };
}
