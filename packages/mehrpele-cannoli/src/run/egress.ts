                                                                                              
// the esbuild-injected fetch shim (fetch-shim.ts), the transport of every provider SDK.
//
//   provider endpoints        allowed when that provider is configured (exact host and port)
//   localhost / 127.0.0.1     allowed when network.allowLocalhost is on
//   network.allow globs       allowed; with askFirstHost the first request to a host asks, and
//                             approvals persist in network.approvedHosts
//   anything else             throws "Host not allowed: <host>"; no request is made
//
// The default transport is Obsidian's requestUrl (injected by main.ts so this module has no
// runtime obsidian import). It must never call the free identifier `fetch` (the shim).
import type { FetchLike } from "./fetch-shim";
import { configuredProviders, type FlowsSettings, providerHost } from "../settings/types";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface EgressEvent {
  url: string;
  host: string;
  allowed: boolean;
  /** The run whose engine fetcher made the request; absent for provider SDK traffic (the shim). */
  runId?: string;
  /** Set on SDK traffic delivered while more than one run was active: it may be another run's. */
  shared?: boolean;
}

export interface EgressOptions {
  getSettings(): FlowsSettings;
  transport: Transport;
  /** First-request prompt for a host matched by network.allow. Resolves true to allow. */
  askHost?(host: string): Promise<boolean>;
  /** Persist an approval (adds the host to network.approvedHosts). */
  onApprove?(host: string): Promise<void> | void;
  onRequest?(event: EgressEvent): void;
}

export class HostNotAllowedError extends Error {
  constructor(readonly host: string) {
    super(`Host not allowed: ${host}`);
    this.name = "HostNotAllowedError";
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const isLocalHostname = (hostname: string): boolean => LOCAL_HOSTNAMES.has(hostname.toLowerCase());

/** `*` matches any run of characters within the host; the match is anchored and case-insensitive. */
export function hostMatches(glob: string, hostname: string): boolean {
  const g = glob.trim().toLowerCase();
  if (!g) return false;
  const re = new RegExp(`^${g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  return re.test(hostname.toLowerCase());
}

/** Hosts (with port) of every configured provider. */
export function providerHosts(settings: FlowsSettings): Set<string> {
  const hosts = new Set<string>();
  for (const p of configuredProviders(settings)) {
    const h = providerHost(settings, p);
    if (h) hosts.add(h);
  }
  return hosts;
}

type Decision = "allow" | "ask" | "deny";

export function decide(settings: FlowsSettings, url: URL): Decision {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "deny";
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  if (providerHosts(settings).has(host)) return "allow";
  if (settings.network.allowLocalhost && isLocalHostname(hostname)) return "allow";
  if (settings.network.allow.some((g) => hostMatches(g, hostname))) {
    if (!settings.network.askFirstHost || settings.network.approvedHosts.includes(hostname)) return "allow";
    return "ask";
  }
  return "deny";
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Folds a Request input into a plain (url, init) pair. */
async function normaliseInput(input: RequestInfo | URL, init?: RequestInit): Promise<[string, RequestInit]> {
  if (typeof input === "string" || input instanceof URL) return [urlOf(input), init ?? {}];
  const req = input;
  const headers = new Headers(req.headers);
  new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
  const method = init?.method ?? req.method;
  const body = init?.body ?? (method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer());
  return [req.url, { ...init, method, headers, body, signal: init?.signal ?? req.signal }];
}

/** fetch, plus the id of the run making the request when the caller knows it. */
export type HostFetch = (input: RequestInfo | URL, init?: RequestInit, runId?: string) => Promise<Response>;

export function createHostFetch(opts: EgressOptions): HostFetch {
  const pendingAsks = new Map<string, Promise<boolean>>();

  const approve = async (hostname: string): Promise<boolean> => {
    let pending = pendingAsks.get(hostname);
    if (!pending) {
      pending = (async () => {
        const ok = opts.askHost ? await opts.askHost(hostname) : false;
        if (ok) await opts.onApprove?.(hostname);
        return ok;
      })().finally(() => pendingAsks.delete(hostname));
      pendingAsks.set(hostname, pending);
    }
    return pending;
  };

  return async (input, init, runId) => {
    const [url, reqInit] = await normaliseInput(input, init);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostNotAllowedError(url);
    }
    let decision = decide(opts.getSettings(), parsed);
    if (decision === "ask") decision = (await approve(parsed.hostname.toLowerCase())) ? "allow" : "deny";
    opts.onRequest?.({
      url: `${parsed.origin}${parsed.pathname}`,
      host: parsed.host,
      allowed: decision === "allow",
      ...(runId ? { runId } : {}),
    });
    if (decision !== "allow") throw new HostNotAllowedError(parsed.host);
    return opts.transport(parsed.href, reqInit);
  };
}

/**
 * Routes egress events to run records. An event tagged with a run id (the engine's own fetcher:
 * HTTP and action nodes) goes to that run only. Provider SDK requests come through the global
 * fetch shim with no run attached, so they go to every active run, marked `shared` when more
 * than one run is active.
 */
export class EgressDispatcher {
  private runs = new Map<string, (e: EgressEvent) => void>();

  subscribe(runId: string, listener: (e: EgressEvent) => void): () => void {
    this.runs.set(runId, listener);
    return () => {
      if (this.runs.get(runId) === listener) this.runs.delete(runId);
    };
  }

  dispatch(event: EgressEvent): void {
    const { runId, ...rest } = event;
    if (runId !== undefined) {
      this.runs.get(runId)?.(rest);
      return;
    }
    const listeners = [...this.runs.values()];
    const delivered = listeners.length > 1 ? { ...rest, shared: true } : rest;
    for (const l of listeners) l({ ...delivered });
  }
}

/** The engine's ResponseTextFetcher on top of hostFetch: errors come back as Error values. */
export function textFetcher(hostFetch: HostFetch): (url: string, init: RequestInit) => Promise<string | Error> {
  return async (url, init) => {
    try {
      const res = await hostFetch(url, init);
      const text = await res.text();
      return res.ok ? text : new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  };
}

// ----- requestUrl transport -----

export interface RequestUrlParamLike {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}
export interface RequestUrlResponseLike {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}
export type RequestUrlLike = (p: RequestUrlParamLike) => Promise<RequestUrlResponseLike>;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

// Headers the browser sets itself (the Fetch spec's forbidden request headers). Electron's
// requestUrl rejects a request carrying any of them with net::ERR_INVALID_ARGUMENT before sending
// it; the OpenAI SDK always sets content-length, so without this no SDK call reached a provider.
const BROWSER_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie2",
  "date",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

/** True for a header requestUrl must not be given (names compare case-insensitively). */
export const isBrowserHeader = (name: string): boolean => {
  const n = name.toLowerCase();
  return BROWSER_HEADERS.has(n) || n.startsWith("proxy-") || n.startsWith("sec-");
};

/**
 * Adapts Obsidian's requestUrl (no CORS, no streaming) to the fetch Response shape. Streaming
 * requests take this path too: the whole SSE body arrives at once and the SDK parses it.
 */
export function requestUrlTransport(requestUrl: RequestUrlLike): Transport {
  return async (url, init) => {
    if (init.signal?.aborted) throw abortError();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      if (!isBrowserHeader(k)) headers[k] = v;
    });
    let body: string | ArrayBuffer | undefined;
    if (typeof init.body === "string") body = init.body;
    else if (init.body != null) {
      const wrapped = new Response(init.body as BodyInit);
      body = await wrapped.arrayBuffer();
      const type = wrapped.headers.get("content-type");
      if (type && !headers["content-type"]) headers["content-type"] = type;
    }
    const res = await requestUrl({
      url,
      method: init.method ?? "GET",
      headers,
      body,
      contentType: headers["content-type"],
      throw: false,
    });
    if (init.signal?.aborted) throw abortError();
    return new Response(NULL_BODY.has(res.status) ? null : res.arrayBuffer, {
      status: res.status,
      headers: res.headers,
    });
  };
}
