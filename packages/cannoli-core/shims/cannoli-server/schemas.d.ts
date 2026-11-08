import type { z } from "zod";

export declare const SuccessResponseSchema: z.ZodObject<{
  status: z.ZodLiteral<"ok">;
}>;

export declare const ErrorResponseSchema: z.ZodObject<{
  status: z.ZodLiteral<"error">;
  message: z.ZodString;
  errors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}>;

export declare const McpProxyServerSchema: z.ZodRecord<
  z.ZodString,
  z.ZodObject<{
    url: z.ZodString;
    headers: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
    transport: z.ZodLiteral<"sse">;
  }>
>;
