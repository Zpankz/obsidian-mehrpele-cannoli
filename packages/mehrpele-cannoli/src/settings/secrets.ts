                                                                                              
// getSecret is called only for ids the user picked, never for enumerated ones.
import type { ProviderId } from "./types";

export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** SecretStorage ids are lowercase alphanumeric with dashes. */
export const SECRET_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidSecretId = (id: string): boolean => SECRET_ID_RE.test(id);

/** The id suggested when a key is created from the companion: mehrpele-flows-key-<provider>. */
export function suggestSecretId(p: ProviderId): string {
  return `mehrpele-flows-key-${p.replace(/_/g, "-")}`;
}

export interface ResolvedSecret {
  id: string;
  value: string;
}

/** Reads one picked secret. Returns null when the id is unset, invalid or empty in storage. */
export function resolveSecret(storage: SecretStorageLike | undefined, id: string | undefined): ResolvedSecret | null {
  if (!storage || !id || !isValidSecretId(id)) return null;
  const value = storage.getSecret(id);
  return value ? { id, value } : null;
}
