// The stubs that replace server, telemetry and tracing modules (README: Security): routing in
// stubPlugin, and the call shapes core and langsmith use at runtime.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stubPlugin } from "../esbuild.config.mjs";
import * as schemas from "../src/stubs/cannoli-server-schemas";
import { makeCannoliServerClient, SERVER_UNAVAILABLE } from "../src/stubs/cannoli-server";
import { createPhoenixWebTracerProvider, LangChainInstrumentation } from "../src/stubs/instrumentation";
import * as otel from "../src/stubs/langsmith-otel";
import * as opentelemetry from "../src/stubs/opentelemetry";

const pkgRoot = resolve(import.meta.dir, "..");
const coreRoot = resolve(pkgRoot, "..", "cannoli-core");

type Resolve = (args: { path: string; importer: string }) => { path: string } | undefined;
const route: Resolve = (() => {
  let cb: Resolve | undefined;
  stubPlugin.setup({ onResolve: (_opts: unknown, fn: Resolve) => (cb = fn) } as never);
  if (!cb) throw new Error("stubPlugin registered no onResolve");
  return cb;
})();
const stubFor = (path: string, importer = resolve(pkgRoot, "src/main.ts")) =>
  route({ path, importer })?.path.slice(resolve(pkgRoot, "src/stubs").length + 1);

describe("stubPlugin routing", () => {
  test.each([
    ["@deablabs/cannoli-server", "cannoli-server.ts"],
    ["@deablabs/cannoli-server/rpc", "cannoli-server.ts"],
    ["@deablabs/cannoli-server/schemas", "cannoli-server-schemas.ts"],
    ["web-instrumentation-langchain", "instrumentation.ts"],
    ["web-instrumentation-langchain/sub", "instrumentation.ts"],
    ["@opentelemetry/sdk-trace-web", "opentelemetry.ts"],
    ["@arizeai/openinference-semantic-conventions", "opentelemetry.ts"],
  ])("%s -> %s", (specifier, stub) => {
    expect(stubFor(specifier)).toBe(stub);
  });

  test("core's own instrumentation module, but not another package's", () => {
    expect(stubFor("./instrumentation", resolve(coreRoot, "src/run.ts"))).toBe("instrumentation.ts");
    expect(stubFor("./instrumentation", resolve(pkgRoot, "node_modules/x/index.js"))).toBeUndefined();
  });

  test("langsmith's OTEL singleton", () => {
    const importer = resolve(pkgRoot, "node_modules/langsmith/dist/client.js");
    expect(stubFor("./singletons/otel.js", importer)).toBe("langsmith-otel.ts");
    expect(stubFor("./singletons/otel.js", resolve(pkgRoot, "node_modules/other/client.js"))).toBeUndefined();
  });

  test("leaves everything else alone", () => {
    expect(stubFor("@deablabs/cannoli-server-extra")).toBeUndefined();
    expect(stubFor("langsmith")).toBeUndefined();
  });
});

describe("cannoli-server stubs", () => {
  test("creating a client throws one clear error", () => {
    expect(() => makeCannoliServerClient({})).toThrow(SERVER_UNAVAILABLE);
  });

  test("schemas import fine but never parse", () => {
    for (const schema of [schemas.SuccessResponseSchema, schemas.ErrorResponseSchema, schemas.McpProxyServerSchema]) {
      expect(() => schema.parse()).toThrow(SERVER_UNAVAILABLE);
      const result = schema.safeParse();
      expect(result.success).toBe(false);
      expect(result.error.message).toBe(SERVER_UNAVAILABLE);
    }
  });
});

describe("telemetry stubs are inert", () => {
  test("core's instrumentation", () => {
    expect(createPhoenixWebTracerProvider({ projectName: "x" })).toBeUndefined();
    expect(() => new LangChainInstrumentation().manuallyInstrument({})).not.toThrow();
  });

  test("langsmith OTEL singleton runs the wrapped function and tracks nothing", () => {
    const trace = otel.getOTELTrace();
    const tracer = trace.getTracer("langsmith");
    expect(tracer.startActiveSpan("run", {}, () => 42)).toBe(42);
    expect(tracer.startActiveSpan("run")).toBeUndefined();
    expect(trace.getActiveSpan()).toBeUndefined();
    const ctx = { k: 1 };
    expect(trace.setSpan(ctx, {})).toBe(ctx);
    expect(trace.setSpanContext(ctx, {})).toBe(ctx);
    expect(trace.getSpan(ctx)).toBeUndefined();
    expect(trace.getTracerProvider()).toBeUndefined();
    expect(trace.setGlobalTracerProvider({})).toBe(false);
    expect(otel.getOTELContext().with(ctx, () => "ran")).toBe("ran");
    expect(otel.getOTELContext().active()).toEqual({});
    expect(otel.setOTELInstances({})).toBeUndefined();
    expect(otel.getDefaultOTLPTracerComponents()).toBeUndefined();
    expect(otel.setDefaultOTLPTracerComponents({})).toBeUndefined();
  });

  test("opentelemetry classes construct and do nothing", () => {
    const provider = new opentelemetry.WebTracerProvider({ resource: new opentelemetry.Resource({}) });
    provider.addSpanProcessor(new opentelemetry.BatchSpanProcessor(new opentelemetry.OTLPTraceExporter({})));
    expect(() => provider.register()).not.toThrow();
  });
});
