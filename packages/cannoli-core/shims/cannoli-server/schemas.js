// Shim for @deablabs/cannoli-server/schemas: the response schemas a client of the server
// would parse, matching upstream packages/cannoli-server/src/schemas.ts. cannoli-core only
// re-exports this module (as `serverSchemas`).
import { z } from "zod";

export const SuccessResponseSchema = z.object({
  status: z.literal("ok"),
});

export const ErrorResponseSchema = z.object({
  status: z.literal("error"),
  message: z.string(),
  errors: z.record(z.unknown()).optional(),
});

export const McpProxyServerSchema = z.record(
  z.string(),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional().default({}),
    transport: z.literal("sse"),
  }),
);
