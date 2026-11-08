/** A portable fetch transport, without runtime-specific static helpers (for example fetch.preconnect in Bun). */
export type ModelFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
