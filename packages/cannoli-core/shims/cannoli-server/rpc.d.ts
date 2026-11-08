// Types for the shim client: only the routes cannoli-core calls (src/providers.ts).

export interface McpProxyServer {
  url: string;
  headers: Record<string, string>;
  transport: "sse";
}

export interface McpServersSseResponse {
  json(): Promise<{ servers: Record<string, McpProxyServer> }>;
}

export interface Client {
  "mcp-servers": {
    sse: {
      /** Always rejects with Error("server not available"). */
      $get(): Promise<McpServersSseResponse>;
    };
  };
}

export interface ClientOptions {
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** Always returns a client whose calls reject with Error("server not available"). */
export declare const makeCannoliServerClient: (
  serverSecret: string,
  baseUrl: string,
  options?: ClientOptions,
) => Client;
