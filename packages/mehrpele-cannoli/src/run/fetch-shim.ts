// The bundle's only `fetch`. esbuild `inject` (esbuild.config.mjs) rewrites every free `fetch`
// reference in bundled code (cannoli-core, the OpenAI/Anthropic/Groq SDK shims, Ollama, Google
// GenAI, langsmith) to this export, so all of their traffic goes through hostFetch without
                                                                   
//
// This file must never reference the free identifier `fetch` itself.

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let active: FetchLike | null = null;

/** Routes bundled fetch calls to `egress` until the returned function is called. */
export function installEgress(egress: FetchLike): () => void {
  active = egress;
  return () => {
    if (active === egress) active = null;
  };
}

function hostOfInput(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
}

/** With no egress installed (no run has started), every request is refused. */
export function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!active) return Promise.reject(new Error(`Host not allowed: ${hostOfInput(input)}`));
  return active(input, init);
}
