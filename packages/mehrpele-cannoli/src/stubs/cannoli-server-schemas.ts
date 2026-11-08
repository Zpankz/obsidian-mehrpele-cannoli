// Stub for @deablabs/cannoli-server/schemas. Core only re-exports it (as `serverSchemas`), so
// importing must not throw. Using a schema fails: parse() throws, safeParse() returns a failure.
import { SERVER_UNAVAILABLE } from "./cannoli-server";

const unavailable = {
  parse(): never {
    throw new Error(SERVER_UNAVAILABLE);
  },
  safeParse() {
    return { success: false as const, error: new Error(SERVER_UNAVAILABLE) };
  },
};

export const SuccessResponseSchema = unavailable;
export const ErrorResponseSchema = unavailable;
export const McpProxyServerSchema = unavailable;
