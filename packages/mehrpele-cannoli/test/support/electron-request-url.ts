// A requestUrl that models Electron's rule: a request carrying a header the browser controls
// (content-length, host, sec-*, proxy-*, ...) is rejected with net::ERR_INVALID_ARGUMENT before
                                                                                                       
// Otherwise it forwards to the real network with the global fetch, as requestUrl would.
import type { RequestUrlLike, RequestUrlParamLike } from "../../src/run/egress";

const FORBIDDEN = new Set([
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

export const isBrowserForbidden = (name: string): boolean => {
  const n = name.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith("proxy-") || n.startsWith("sec-");
};

/** `respond` replaces the network (unit tests); by default the request goes out for real. */
export function electronRequestUrl(seen: RequestUrlParamLike[] = [], respond?: RequestUrlLike): RequestUrlLike {
  return async (p) => {
    seen.push(p);
    const bad = Object.keys(p.headers ?? {}).filter(isBrowserForbidden);
    if (bad.length) throw new Error(`net::ERR_INVALID_ARGUMENT (forbidden header: ${bad.join(", ")})`);
    if (respond) return respond(p);
    const res = await globalThis.fetch(p.url, { method: p.method, headers: p.headers, body: p.body });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, arrayBuffer: await res.arrayBuffer() };
  };
}
