// The bundle's only `console`. esbuild `inject` (esbuild.config.mjs) rewrites every free `console`
// reference in bundled code (cannoli-core, the provider SDKs, the companion) to this export, so a
// key that the core or an SDK logs (CannoliVertex.error logs provider error bodies raw) is
                                                                                                   
//
// Every key a run resolves is added here and kept until the plugin unloads, since a late log line
// can outlive its run. This file must reach the real console only through globalThis.console.
import { createRedactor, type Redactor, type SecretValue } from "./redact";

const LOGGERS = new Set<PropertyKey>(["log", "info", "warn", "error", "debug", "trace", "dir", "table", "group", "groupCollapsed", "assert"]);

const secrets = new Map<string, SecretValue>();
let redactor: Redactor | null = null;

/** Redacts `secret` (all its forms) from every console line until clearConsoleSecrets. */
export function addConsoleSecret(secret: SecretValue): void {
  if (!secret.value || secrets.has(secret.value)) return;
  secrets.set(secret.value, secret);
  redactor = createRedactor([...secrets.values()]);
}

export function clearConsoleSecrets(): void {
  secrets.clear();
  redactor = null;
}

function scrub(r: Redactor, v: unknown): unknown {
  if (typeof v === "string") return r.text(v);
  if (v instanceof Error) {
    const copy = new Error(r.text(v.message));
    copy.name = v.name;
    copy.stack = v.stack === undefined ? undefined : r.text(v.stack);
    return copy;
  }
  if (v && typeof v === "object") {
    let json: string | undefined;
    try {
      json = JSON.stringify(v);
    } catch {
      return "[object not logged: it could not be checked for keys]";
    }
    if (json !== undefined && r.text(json) !== json) return JSON.parse(r.text(json));
  }
  return v;
}

/** Scrubs every argument when a key is registered; otherwise passes the call through as is. */
export const console: Console = new Proxy({} as Console, {
  get(_target, prop) {
    const real = globalThis.console;
    const value: unknown = Reflect.get(real, prop);
    if (typeof value !== "function") return value;
    if (!LOGGERS.has(prop)) return (value as (...args: unknown[]) => unknown).bind(real);
    return (...args: unknown[]) => {
      const r = redactor;
      return (value as (...args: unknown[]) => unknown).apply(real, r ? args.map((a) => scrub(r, a)) : args);
    };
  },
});
