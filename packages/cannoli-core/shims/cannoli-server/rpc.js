// Shim for @deablabs/cannoli-server/rpc. Mehrpele never talks to cannoli-server, so every
// route on the client is a function that rejects with "server not available".
const unavailable = () => Promise.reject(new Error("server not available"));

// Any property path ends in a callable that rejects, e.g. client["mcp-servers"].sse.$get().
// `then` stays undefined so the client itself is not mistaken for a promise.
const route = () =>
  new Proxy(unavailable, {
    get: (_target, key) => (key === "then" ? undefined : route()),
  });

export const makeCannoliServerClient = (_serverSecret, _baseUrl, _options) => route();
