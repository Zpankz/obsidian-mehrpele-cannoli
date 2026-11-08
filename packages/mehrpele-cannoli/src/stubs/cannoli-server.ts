// Stub for @deablabs/cannoli-server (and /rpc). Mehrpele Flows never talks to a cannoli-server:
// core only reaches it for goal-completion MCP tools, and that path fails with this error.
export const SERVER_UNAVAILABLE = "cannoli-server is not available in Mehrpele Flows";

export function makeCannoliServerClient(..._args: unknown[]): never {
  throw new Error(SERVER_UNAVAILABLE);
}
