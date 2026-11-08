import { vi } from "vitest";
import type { Client } from "./cannoli-server/rpc";

/** Only the upstream tests' mocked endpoint is available; never a real server. */
export function makeCannoliServerClient(secret: string, baseUrl: string): Client {
  return { "mcp-servers": { sse: { $get: async () => {
    if (baseUrl !== "http://cannoli-server.test" || !vi.isMockFunction(globalThis.fetch)) throw new Error("server not available");
    return globalThis.fetch(`${baseUrl}/mcp-servers/sse`, { headers: { Authorization: `Bearer ${secret}` } });
  } } } };
}
