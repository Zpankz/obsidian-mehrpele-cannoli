                                                                                       
// plugin's folder (store-lint allowlists it): on click only, read-only, through the vault
// adapter. Cannoli's file is never written.
import { type SecretStorageLike, suggestSecretId } from "./secrets";
import { type FlowsSettings, OLLAMA_DEFAULT_URL, type ProviderId } from "./types";

export interface ImportApp {
  vault: {
    configDir: string;
    adapter: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> };
  };
  secretStorage?: SecretStorageLike;
}

export const IMPORT_BANNER = "Cannoli detected: import its provider keys into secure storage?";
export const IMPORT_DONE =
  "Keys copied. Cannoli still stores its own copy in plain text; remove it there if you no longer use Cannoli.";

/** Cannoli's settings field -> our provider. */
const KEY_FIELDS: [field: string, provider: ProviderId][] = [
  ["openaiAPIKey", "openai"],
  ["anthropicAPIKey", "anthropic"],
  ["geminiAPIKey", "gemini"],
  ["groqAPIKey", "groq"],
  ["azureAPIKey", "azure_openai"],
];

const URL_FIELDS: [field: string, provider: ProviderId][] = [
  ["openaiBaseURL", "openai"],
  ["anthropicBaseURL", "anthropic"],
  ["ollamaBaseUrl", "ollama"],
];

export function cannoliDataPath(configDir: string): string {
  return `${configDir}/plugins/cannoli/data.json`;
}

/** Whether Cannoli's settings file exists. Called only when the settings tab opens. */
export async function cannoliDataExists(app: ImportApp): Promise<boolean> {
  try {
    return await app.vault.adapter.exists(cannoliDataPath(app.vault.configDir));
  } catch {
    return false;
  }
}

export interface ImportResult {
  imported: ProviderId[];
  baseUrls: ProviderId[];
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Copies each non-empty Cannoli key into SecretStorage as mehrpele-flows-key-<provider> and
 * stores that id in `settings` (mutated; the caller saves). Base URLs are carried over too.
 */
export async function importCannoliKeys(app: ImportApp, settings: FlowsSettings): Promise<ImportResult> {
  if (!app.secretStorage) throw new Error("Secure storage needs Obsidian 1.11.4 or later");
  const raw = await app.vault.adapter.read(cannoliDataPath(app.vault.configDir));
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Cannoli's settings file is not valid JSON");
  }
  const result: ImportResult = { imported: [], baseUrls: [] };
  for (const [field, p] of KEY_FIELDS) {
    const key = data[field];
    if (!nonEmpty(key)) continue;
    const id = suggestSecretId(p);
    app.secretStorage.setSecret(id, key.trim());
    settings.providers[p] = { ...settings.providers[p], secretId: id };
    result.imported.push(p);
  }
  for (const [field, p] of URL_FIELDS) {
    const url = data[field];
    if (!nonEmpty(url) || settings.providers[p]?.baseUrl) continue;
    // Cannoli always stores Ollama's default URL; carrying it would switch Ollama on unasked.
    if (p === "ollama" && url.trim().replace(/\/+$/, "") === OLLAMA_DEFAULT_URL) continue;
    settings.providers[p] = { ...settings.providers[p], baseUrl: url.trim() };
    result.baseUrls.push(p);
  }
  if (!settings.defaultProvider && result.imported.length) settings.defaultProvider = result.imported[0];
  return result;
}
