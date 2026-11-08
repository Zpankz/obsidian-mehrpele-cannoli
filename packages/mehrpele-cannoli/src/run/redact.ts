                                                                                             
// becomes ‹secret:id› in run records, error messages and notices.

export interface SecretValue {
  id: string;
  value: string;
}

export interface Redactor {
  text(s: string): string;
  /** Deep copy of plain data with every string redacted (object keys too). */
  deep<T>(v: T): T;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The forms a secret can leak in. Shorter forms are dropped to avoid redacting noise. */
export function secretForms(value: string): string[] {
  const b64 = base64(value);
  const forms = [
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ];
  return [...new Set(forms)].filter((f) => f.length >= 4);
}

export function createRedactor(secrets: readonly SecretValue[]): Redactor {
  const pairs: [form: string, label: string][] = [];
  for (const { id, value } of secrets) {
    if (!value) continue;
    for (const form of secretForms(value)) pairs.push([form, `‹secret:${id}›`]);
  }
  // Longest first, so a base64 form is not half-replaced by a shorter plain form.
  pairs.sort((a, b) => b[0].length - a[0].length);

  const text = (s: string): string => {
    let out = s;
    for (const [form, label] of pairs) if (out.includes(form)) out = out.split(form).join(label);
    return out;
  };

  const deep = <T>(v: T): T => {
    if (typeof v === "string") return text(v) as T;
    if (Array.isArray(v)) return (v as unknown[]).map((x) => deep(x)) as T;
    if (v instanceof Error) return text(v.message) as T;
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[text(k)] = deep(x);
      return out as T;
    }
    return v;
  };

  return { text, deep };
}
